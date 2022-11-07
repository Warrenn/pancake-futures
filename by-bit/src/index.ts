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
    while (true) {
        let positionPending = await hasPosition("SELL", orderQty, triggerPrice)
        if (positionPending) {
            console.log(`Sell position already pending qty:${orderQty} trigger:${triggerPrice}`);
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
    }
}

async function immediateSell(orderQty: float) {
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
    }
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
    let holding = position.free >= quantity || hasPendingSell;
    let { result: { price } } = await client.getLastTradedPrice(symbol);

    let aboveStrike = price > strikePrice;

    let sellPrice = strikePrice;
    if (price > strikeUpper) sellPrice = strikeUpper;

    let buyPrice = strikePrice;
    if (price < strikeLower) buyPrice = strikeLower;

    console.log(`borrowing: ${borrowing} aboveStrike: ${aboveStrike} holding: ${holding} sell: ${hasPendingSell} buy: ${hasPendingBuy} sellPrice:${sellPrice} buyPrice:${buyPrice}`);

    if (!borrowing) {
        let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);
        //TODO: need to consider this properly
        if (borrowResponse.retCode != 0) exit(-1);
    }

    if (!borrowing && aboveStrike && !hasPendingSell) await conditionalSell(quantity, sellPrice);

    if (!borrowing && !aboveStrike) await immediateSell(quantity);

    if (borrowing && aboveStrike && !holding) await immediateBuy(quantity * buyPrice);

    if (borrowing && aboveStrike && holding && !hasPendingSell) await conditionalSell(quantity, sellPrice);

    if (borrowing && !aboveStrike && holding && !hasPendingSell) await immediateSell(quantity);

    if (borrowing && !aboveStrike && !holding && !hasPendingBuy) await conditionalBuy(quantity * buyPrice, buyPrice);

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