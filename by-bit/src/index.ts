import { float, integer } from "aws-sdk/clients/lightsail";
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import dotenv from "dotenv";
import { exit } from "process";

dotenv.config();

const slippage = 0.003;
const symbol = 'ETHUSDT';
const coin = 'ETH';
const strikePrice = 367.5;
const quantity = 6;

const useTestnet = !!(process.env.TESTNET?.localeCompare("false", 'en', { sensitivity: 'accent' }));

let inprocess = false;
const strikeLower = strikePrice * (1 - slippage);
const strikeUpper = strikePrice * (1 + slippage);

const client = new SpotClientV3({
    testnet: useTestnet,
    key: process.env.API_KEY,
    secret: process.env.API_SECRET
});

const wsClient = new WebsocketClient({
    testnet: useTestnet,
    key: process.env.API_KEY,
    secret: process.env.API_SECRET,
    market: 'spotv3'
});

function round(num: number, precision: integer = 2) {
    return +(Math.round(+(num + `e+${precision}`)) + `e-${precision}`);
}

async function conditionalSell(orderQty: float, triggerPrice: float) {
    orderQty = round(orderQty, 5);
    triggerPrice = round(triggerPrice, 2);
    await ensureSellFunds(coin, orderQty);
    while (true) {
        let positionPending = await hasPosition("SELL", orderQty, triggerPrice)
        if (positionPending) {
            console.log(`Sell position already pending qty:${orderQty} trigger:${triggerPrice}`);
            return;
        }
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        if (price > triggerPrice) {
            console.error(`Sell error price ${price} is greater than trigger ${triggerPrice}`);
            return;
        }
        let orderResponse = await client.submitOrder({
            orderType: "MARKET",
            orderQty: `${orderQty}`,
            side: "Sell",
            symbol: symbol,
            triggerPrice: `${triggerPrice}`,
            orderCategory: 1
        });
        console.log(`conditional sell: ${JSON.stringify(orderResponse, null, 2)}`);
        //TODO: figure out what to do if the order fails
        if (orderResponse.retCode == 0) return;
        console.error(orderResponse.retMsg);
    }
}

async function immediateSell(orderQty: float) {
    await ensureSellFunds(coin, orderQty);
    while (true) {
        let orderResponse = await client.submitOrder({
            orderType: "MARKET",
            orderQty: `${round(orderQty, 5)}`,
            side: "Sell",
            symbol: symbol
        });
        console.log(`immediate sell: ${JSON.stringify(orderResponse, null, 2)}`);
        //TODO: figure out what to do if the order fails
        if (orderResponse.retCode == 0) return;
        console.error(orderResponse.retMsg);
    }
}

async function immediateBuy(orderQty: float) {
    while (true) {
        let orderResponse = await client.submitOrder({
            orderType: "MARKET",
            orderQty: `${round(orderQty, 2)}`,
            side: "Buy",
            symbol: symbol
        });
        console.log(`immediate buy: ${JSON.stringify(orderResponse, null, 2)}`);
        //TODO: figure out what to do if the order fails
        if (orderResponse.retCode == 0) return;
        console.error(orderResponse.retMsg);
    }
}

async function hasPosition(side: string, qty: number, trigger: number): Promise<boolean> {
    let { result: { list: orders } } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    return !!(<any[]>orders).find(order =>
        order.side == side &&
        order.orderQty == `${qty}` &&
        order.triggerPrice == `${trigger}`);
}

async function conditionalBuy(orderQty: float, triggerPrice: float) {
    orderQty = round(orderQty, 2);
    triggerPrice = round(triggerPrice, 2);
    while (true) {
        let positionPending = await hasPosition("BUY", orderQty, triggerPrice);
        if (positionPending) {
            console.log(`Buy position already pending qty:${orderQty} trigger:${triggerPrice}`);
            return;
        }
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        if (price < triggerPrice) {
            console.error(`Buy error price ${price} is less than trigger ${triggerPrice}`);
            return;
        }
        let orderResponse = await client.submitOrder({
            orderType: "MARKET",
            orderQty: `${orderQty}`,
            side: "Buy",
            symbol: symbol,
            triggerPrice: `${triggerPrice}`,
            orderCategory: 1
        });
        //TODO: figure out what to do if the order fails
        console.log(`conditional buy: ${JSON.stringify(orderResponse, null, 2)}`);
        if (orderResponse.retCode == 0) return;
        console.error(orderResponse.retMsg);
    }
}

async function ensureSellFunds(coin: string, quantity: number) {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = (<any[]>loanAccountList).find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    if (position.free >= quantity) return;
    let stillNeed = round(quantity - position.free, 5);
    await borrowFunds(coin, stillNeed);
}

async function borrowFunds(coin: string, quantity: number) {
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);
    //TODO: need to consider this properly
    if (borrowResponse.retCode != 0) throw borrowResponse.retMsg;
}

async function InitializePosition() {
    if (inprocess) return;
    inprocess = true;
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = (<any[]>loanAccountList).find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };

    let { result: { list: orders } } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    let hasPendingSell = !!(<any[]>orders).find(order => order.side == "SELL" && order.orderQty == `${quantity}`);
    let hasPendingBuy = !!(<any[]>orders).find(order => order.side == "BUY" && order.orderQty == `${quantity}`);

    let borrowing = position.loan >= quantity;
    let holding = position.free > 0 || hasPendingSell;
    let { result: { price } } = await client.getLastTradedPrice(symbol);

    let loggedMessage = false;
    while (price > strikeLower && price < strikeUpper) {
        if (!loggedMessage) {
            console.log(`Price ${price} is between ${strikeLower} and ${strikeUpper}`);
            loggedMessage = true;
        }

        await asyncSleep(1000);

        let { result: { price: lastPrice } } = await client.getLastTradedPrice(symbol);
        price = lastPrice;
    }

    let aboveStrike = price > strikeUpper;

    console.log(`borrowing: ${borrowing} aboveStrike: ${aboveStrike} holding: ${holding} sell: ${hasPendingSell} buy: ${hasPendingBuy} `);

    if (!borrowing) {
        await borrowFunds(coin, quantity);
        holding = true;
    }

    if (aboveStrike && !holding) {
        await immediateBuy(quantity * price);
    }

    if (aboveStrike && !hasPendingSell) {
        await conditionalSell(quantity, strikeUpper);
    }

    if (!aboveStrike && holding) {
        await immediateSell(quantity);
    }

    if (!aboveStrike && !hasPendingBuy) {
        await conditionalBuy(quantity * strikePrice, strikeLower);
    }

    inprocess = false;
}

try {
    process.stdin.on('data', process.exit.bind(process, 0));

    wsClient.on('update', data => {
        console.log(`update: ${JSON.stringify(data, null, 2)}`);
        (async () => { await InitializePosition(); })();
    });

    wsClient.subscribe(['ticketInfo', 'order'], true);

    await InitializePosition();

    while (true) {
        await asyncSleep(1000);
    }
}
catch (err) {
    console.error(err);
}