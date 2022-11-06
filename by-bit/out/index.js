var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import dotenv from "dotenv";
import { exit } from "process";
dotenv.config();
const orderPrecision = 2;
const symbol = 'ETHUSDT';
const coin = 'ETH';
const strikePrice = 363;
const quantity = 6;
const useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' }));
let inprocess = false;
const strikeLower = strikePrice * 0.9962191781; //slippage
const strikeUpper = strikePrice * 1.006931507; //slippage
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
async function conditionalSell(orderQty, triggerPrice) {
    orderQty = parseFloat(orderQty.toFixed(orderPrecision));
    triggerPrice = parseFloat(triggerPrice.toFixed(orderPrecision));
    while (true) {
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
        if (orderResponse.retCode == 0)
            return;
    }
}
async function immediateSell(orderQty) {
    orderQty = parseFloat(orderQty.toFixed(orderPrecision));
    while (true) {
        let orderResponse = await client.submitOrder({
            orderType: "MARKET",
            orderQty: `${orderQty}`,
            side: "Sell",
            symbol: symbol
        });
        console.log(`immediate sell: ${JSON.stringify(orderResponse, null, 2)}`);
        //TODO: figure out what to do if the order fails
        if (orderResponse.retCode == 0)
            return;
    }
}
async function immediateBuy(orderQty) {
    orderQty = parseFloat(orderQty.toFixed(orderPrecision));
    while (true) {
        let orderResponse = await client.submitOrder({
            orderType: "MARKET",
            orderQty: `${orderQty}`,
            side: "Buy",
            symbol: symbol
        });
        console.log(`immediate buy: ${JSON.stringify(orderResponse, null, 2)}`);
        //TODO: figure out what to do if the order fails
        if (orderResponse.retCode == 0)
            return;
    }
}
async function conditionalBuy(orderQty, triggerPrice) {
    orderQty = parseFloat(orderQty.toFixed(orderPrecision));
    triggerPrice = parseFloat(triggerPrice.toFixed(4));
    while (true) {
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
        if (orderResponse.retCode == 0)
            return;
    }
}
async function InitializePosition() {
    if (inprocess)
        return;
    inprocess = true;
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    let { result: { list: orders } } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    let hasPendingSell = !!orders.find(order => order.side == "SELL" && order.orderQty == `${quantity}`);
    let hasPendingBuy = !!orders.find(order => order.side == "BUY" && order.orderQty == `${quantity}`);
    let borrowing = position.loan >= quantity;
    let holding = position.free >= quantity || hasPendingSell;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    while (price < strikeUpper && price > strikeLower) {
        console.log('at strike waiting before continuing');
        await asyncSleep(1000);
        let { result: { price: updatedPrice } } = await client.getLastTradedPrice(symbol);
        price = parseFloat(updatedPrice);
    }
    let aboveStrike = price > strikeUpper;
    console.log(`borrowing: ${borrowing} aboveStrike: ${aboveStrike} holding: ${holding} sell: ${hasPendingSell} buy: ${hasPendingBuy}`);
    if (!borrowing) {
        let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);
        //TODO: need to consider this properly
        if (borrowResponse.retCode != 0)
            exit(-1);
    }
    if (!borrowing && aboveStrike && !hasPendingSell)
        await conditionalSell(quantity, strikeUpper);
    if (!borrowing && !aboveStrike)
        await immediateSell(quantity);
    if (borrowing && aboveStrike && !holding)
        await immediateBuy(quantity * strikeLower);
    if (borrowing && aboveStrike && holding && !hasPendingSell)
        await conditionalSell(quantity, strikeUpper);
    if (borrowing && !aboveStrike && holding && !hasPendingSell)
        await immediateSell(quantity);
    if (borrowing && !aboveStrike && !holding && !hasPendingBuy)
        await conditionalBuy(quantity * strikeLower, strikeLower);
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
        // let rr = await client.repayCrossMarginLoan('ETH', `${quantity}`);
    }
}
catch (err) {
    console.error(err);
}
//# sourceMappingURL=index.js.map