import { float, integer } from "aws-sdk/clients/lightsail";
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import dotenv from "dotenv";

dotenv.config();

const slippage = parseFloat(`${process.env.SLIPPAGE}`);
const symbol = 'ETHUSDT';
const coin = 'ETH';
const strikePrice = parseFloat(`${process.env.STRIKEPRICE}`);
const quantity = parseFloat(`${process.env.QUANTITY}`);

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
    triggerPrice = round(triggerPrice, 2);
    orderQty = round((await getSellableAmount(coin, orderQty)), 5);
    while (true) {
        let positionPending = await hasPosition("SELL", orderQty, triggerPrice)
        if (positionPending) {
            console.log(`Sell position already pending qty:${orderQty} trigger:${triggerPrice}`);
            return;
        }
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        if (price < triggerPrice) {
            console.error(`Sell error price ${price} is less than trigger ${triggerPrice}`);
            await asyncSleep(1000);
            continue;
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
    orderQty = round((await getSellableAmount(coin, orderQty)), 5);
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
        if (price > triggerPrice) {
            console.error(`Buy error price ${price} is greater than trigger ${triggerPrice}`);
            await asyncSleep(1000);
            continue;
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

async function getSellableAmount(coin: string, quantity: number): Promise<number> {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = (<any[]>loanAccountList).find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    return Math.min(quantity, position.free);
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
    let holding = position.free > quantity || hasPendingSell;
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
        let runway = round(Math.max(quantity * price * 0.0015, 1), 2);
        await immediateBuy(runway);
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
        (async () => {
            try {
                await InitializePosition();
            }
            catch (err) {
                console.error(err);
            }
        })();
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