var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import dotenv from "dotenv";
dotenv.config();
const interest = 0.0015, slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = 'ETHUSDT', coin = 'ETH', quantity = parseFloat(`${process.env.QUANTITY}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' }));
;
let strikePrice = parseFloat(`${process.env.STRIKEPRICE}`), inprocess = false, runInitialize = true, { strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage);
const client = new SpotClientV3({
    testnet: useTestnet,
    key: process.env.API_KEY,
    secret: process.env.API_SECRET,
    recv_window: 999999
});
const wsClient = new WebsocketClient({
    testnet: useTestnet,
    key: process.env.API_KEY,
    secret: process.env.API_SECRET,
    market: 'spotv3',
    // fetchTimeOffsetBeforeAuth: true
    // reconnectTimeout:
});
function setStrikeBoundries(strikePrice, slippage) {
    let strikeLower = strikePrice * (1 - slippage), strikeUpper = strikePrice * (1 + slippage);
    return { strikeLower, strikeUpper };
}
function round(num, precision = 2) {
    return +(Math.round(+(num + `e+${precision}`)) + `e-${precision}`);
}
async function conditionalSell(coin, symbol, orderQty, triggerPrice) {
    triggerPrice = round(triggerPrice, 2);
    orderQty = round((await getSellableAmount(coin, orderQty)), 5);
    let positionPending = await hasPosition(symbol, "SELL", orderQty, triggerPrice);
    if (positionPending) {
        console.log(`Sell position already pending qty:${orderQty} trigger:${triggerPrice}`);
        return;
    }
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    if (price < triggerPrice) {
        console.error(`Sell error price ${price} is less than trigger ${triggerPrice}`);
        runInitialize = true;
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
    if (orderResponse.retCode == 0)
        return;
    console.error(orderResponse.retMsg);
    runInitialize = true;
}
async function immediateSell(coin, symbol, orderQty) {
    orderQty = round((await getSellableAmount(coin, orderQty)), 5);
    let orderResponse = await client.submitOrder({
        orderType: "MARKET",
        orderQty: `${orderQty}`,
        side: "Sell",
        symbol: symbol
    });
    console.log(`immediate sell: ${JSON.stringify(orderResponse, null, 2)}`);
    if (orderResponse.retCode == 0)
        return;
    console.error(orderResponse.retMsg);
    runInitialize = true;
}
async function immediateBuy(symbol, orderQty) {
    orderQty = round(orderQty, 2);
    let orderResponse = await client.submitOrder({
        orderType: "MARKET",
        orderQty: `${orderQty}`,
        side: "Buy",
        symbol: symbol
    });
    console.log(`immediate buy: ${JSON.stringify(orderResponse, null, 2)}`);
    if (orderResponse.retCode == 0)
        return;
    console.error(orderResponse.retMsg);
    runInitialize = true;
}
async function hasPosition(symbol, side, qty, trigger) {
    let { result: { list: orders } } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    return !!orders.find(order => order.side == side &&
        +order.orderQty >= qty &&
        order.triggerPrice == `${trigger}`);
}
async function conditionalBuy(symbol, orderQty, triggerPrice) {
    orderQty = round(orderQty, 5);
    triggerPrice = round(triggerPrice, 2);
    let positionPending = await hasPosition(symbol, "BUY", orderQty, triggerPrice);
    if (positionPending) {
        console.log(`Buy position already pending qty:${orderQty} trigger:${triggerPrice}`);
        return;
    }
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    if (price > triggerPrice) {
        console.error(`Buy error price ${price} is greater than trigger ${triggerPrice}`);
        runInitialize = true;
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
    console.log(`conditional buy: ${JSON.stringify(orderResponse, null, 2)}`);
    if (orderResponse.retCode == 0)
        return;
    console.error(orderResponse.retMsg);
    runInitialize = true;
}
async function getSellableAmount(coin, quantity) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0)
        throw response.retMsg;
    let { result: { loanAccountList } } = response;
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    return Math.min(quantity, position.free);
}
async function borrowFunds(coin, quantity) {
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);
    //TODO: need to consider this properly
    if (borrowResponse.retCode != 0)
        throw borrowResponse.retMsg;
}
async function InitializePosition() {
    if (inprocess)
        return;
    inprocess = true;
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    let { result: { list: orders } } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    let hasPendingSell = !!orders.find(order => order.side == "SELL" && +order.orderQty >= quantity);
    let hasPendingBuy = !!orders.find(order => order.side == "BUY" && +order.orderQty >= quantity);
    let borrowing = position.loan >= quantity;
    let holding = position.free >= quantity || hasPendingSell;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    let loggedMessage = false;
    while (price > strikeLower && price < strikeUpper) {
        if (!loggedMessage) {
            console.log(`Price ${price} is between ${strikeLower} and ${strikeUpper}`);
            loggedMessage = true;
        }
        await asyncSleep(1000);
        ({ result: { price } } = await client.getLastTradedPrice(symbol));
    }
    if (loggedMessage)
        console.log(`Price ${price} lower ${strikeLower} upper ${strikeUpper}`);
    ({ result: { price } } = await client.getLastTradedPrice(symbol));
    let aboveStrike = price > strikeUpper;
    console.log(`borrowing: ${borrowing} aboveStrike: ${aboveStrike} holding: ${holding} sell: ${hasPendingSell} buy: ${hasPendingBuy} `);
    if (!borrowing) {
        await borrowFunds(coin, quantity);
        let runway = round(Math.max(quantity * price * interest, 1), 2);
        await immediateBuy(symbol, runway);
        holding = true;
    }
    if (aboveStrike && !holding) {
        await immediateBuy(symbol, quantity);
    }
    if (aboveStrike && !hasPendingSell) {
        await conditionalSell(coin, symbol, quantity, strikeUpper);
    }
    if (!aboveStrike && holding) {
        await immediateSell(coin, symbol, quantity);
    }
    if (!aboveStrike && !hasPendingBuy) {
        await conditionalBuy(symbol, quantity * strikeLower, strikeLower);
    }
    inprocess = false;
}
try {
    process.stdin.on('data', process.exit.bind(process, 0));
    wsClient.on('update', message => {
        var _a;
        console.log(`update: ${message === null || message === void 0 ? void 0 : message.topic}`);
        runInitialize = true;
        if ((message === null || message === void 0 ? void 0 : message.topic) != 'ticketInfo' || !((_a = message === null || message === void 0 ? void 0 : message.data) === null || _a === void 0 ? void 0 : _a.length))
            return;
        console.log(`snapshot: ${JSON.stringify(message, null, 2)}`);
        const data = message.data[0];
        strikePrice = (data.S == "SELL") ? Math.min(+data.p, strikePrice) : Math.max(+data.p, strikePrice);
        ({ strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage));
    });
    wsClient.subscribe(['ticketInfo', 'order', 'stopOrder'], true);
    while (true) {
        if (!runInitialize) {
            await asyncSleep(1000);
            continue;
        }
        runInitialize = false;
        await InitializePosition();
    }
}
catch (err) {
    console.error(err);
}
//# sourceMappingURL=index.js.map