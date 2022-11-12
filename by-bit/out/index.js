var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import dotenv from "dotenv";
dotenv.config();
const interest = 0.0015, slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = 'ETHUSDT', baseCurrency = 'ETH', quoteCurrency = 'USDT', quantity = parseFloat(`${process.env.QUANTITY}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' }));
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
    fetchTimeOffsetBeforeAuth: true
});
function setStrikeBoundries(strikePrice, slippage) {
    let strikeLower = round(strikePrice * (1 - slippage), 2), strikeUpper = round(strikePrice * (1 + slippage), 2);
    return { strikeLower, strikeUpper };
}
function round(num, precision = 2) {
    return +(Math.round(+(num + `e+${precision}`)) + `e-${precision}`);
}
async function cancelOrders(orderIds) {
    let errors = '';
    for (let orderId of orderIds) {
        let response = await client.cancelOrder({ orderId, orderCategory: 1 });
        if (response.retCode == 0)
            continue;
        errors += `orderId: ${orderId} failed: ${response.retMsg}`;
    }
    if (!errors)
        return;
    runInitialize = true;
    log.error(`cancelOrders ${errors}`);
}
async function conditionalBuy(symbol, orderQty, triggerPrice, quoteCoin = quoteCurrency) {
    orderQty = round(orderQty, 5);
    triggerPrice = round(triggerPrice, 2);
    while (true) {
        console.log(`conditional buy qty: ${orderQty} trigger ${triggerPrice}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            side: "Buy",
            symbol: symbol,
            triggerPrice: `${triggerPrice}`,
            orderPrice: `${triggerPrice}`,
            orderCategory: 1
        });
        if (orderResponse.retCode == 12228) {
            console.error(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * triggerPrice, 2);
            continue;
        }
        if (orderResponse.retCode == 0) {
            let orderId = orderResponse.result.orderId;
            let { result: order, retCode, retMsg } = await client.getOrder({ orderId, orderCategory: 1 });
            if (retCode != 0) {
                log.error(`conditionalBuy ${retMsg}`);
                runInitialize = true;
                return;
            }
            let { result: { price } } = await client.getLastTradedPrice(symbol);
            if (price > order.triggerPrice) {
                console.error(`Buy error price ${price} is greater than trigger ${order.triggerPrice}`);
                await client.cancelOrder({ orderId });
                runInitialize = true;
            }
            return;
        }
        console.error(orderResponse.retMsg);
        runInitialize = true;
        return;
    }
}
async function conditionalSell(coin, symbol, orderQty, triggerPrice) {
    orderQty = round(orderQty, 5);
    triggerPrice = round(triggerPrice, 2);
    while (true) {
        console.log(`conditional sell qty: ${orderQty} trigger ${triggerPrice} `);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            side: "Sell",
            symbol: symbol,
            triggerPrice: `${triggerPrice}`,
            orderPrice: `${triggerPrice}`,
            orderCategory: 1
        });
        if (orderResponse.retCode == 12229) {
            console.error(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = round(orderQty, 5);
            if (orderQty > 0)
                continue;
            runInitialize = true;
            return;
        }
        if (orderResponse.retCode == 0) {
            let orderId = orderResponse.result.orderId;
            let { result: order, retCode, retMsg } = await client.getOrder({ orderId, orderCategory: 1 });
            if (retCode != 0) {
                console.error(`conditionalSell ${retMsg}`);
                runInitialize = true;
                return;
            }
            let { result: { price } } = await client.getLastTradedPrice(symbol);
            if (price < order.triggerPrice) {
                console.error(`Sell error price ${price} is less than trigger ${order.triggerPrice} `);
                await client.cancelOrder({ orderId });
                runInitialize = true;
            }
            return;
        }
        console.error(orderResponse.retMsg);
        runInitialize = true;
        return;
    }
}
async function immediateSell(symbol, orderQty, coin = baseCurrency) {
    orderQty = round(orderQty, 5);
    while (true) {
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        console.log(`immediate sell qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: price,
            side: "Sell",
            symbol: symbol
        });
        if (orderResponse.retCode == 12229) {
            console.error(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = round(orderQty, 5);
            if (orderQty > 0)
                continue;
            runInitialize = true;
            return;
        }
        if (orderResponse.retCode == 0)
            return;
        console.error(orderResponse.retMsg);
        runInitialize = true;
        return;
    }
}
async function immediateBuy(symbol, orderQty, quoteCoin = quoteCurrency) {
    orderQty = round(orderQty, 5);
    while (true) {
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        console.log(`immediate buy qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: price,
            side: "Buy",
            symbol: symbol
        });
        if (orderResponse.retCode == 12228) {
            console.error(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * price, 2);
            continue;
        }
        if (orderResponse.retCode == 0)
            return;
        console.error(orderResponse.retMsg);
        runInitialize = true;
        return;
    }
}
async function borrowIfRequired(coin, quantity, precision = 2) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        console.error(`borrowIfRequired ${response.retMsg}`);
        runInitialize = true;
        return;
    }
    let { result: { loanAccountList } } = response;
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    console.log(`borrowIfRequired free:${position.free} quantity: ${quantity}`);
    if (position.free >= quantity)
        return;
    let diff = round(quantity - position.free, precision);
    if (diff == 0)
        return;
    await borrowFunds(coin, diff);
}
async function getSellableAmount(coin, quantity) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        console.error(`getSellableAmount ${response.retMsg}`);
        runInitialize = true;
        return quantity;
    }
    let { result: { loanAccountList } } = response;
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    return Math.min(quantity, position.free);
}
async function borrowFunds(coin, quantity) {
    if (coin == quoteCurrency && quantity < 10)
        quantity = 10;
    console.log(`borrow ${coin} ${quantity}`);
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);
    //TODO: need to consider this properly
    if (borrowResponse.retCode == 0)
        return;
    console.error(`borrowFunds ${borrowResponse.retMsg}`);
    runInitialize = true;
}
/*

check every 1s
==============

check the portfolio status
get upper strike lower
get the market value
get current order position

short:
    loan value made but no holding amount
long:
    no loan and no coin
    loan value but have a holding amount

if loan < orderSize:
    take out a loan for difference
    buy a little bit more for interest and overruns
    add bit to holding
    add difference to holding

if holding < loanSize and above strike:
    buy difference
    add difference to holding
    long position

if holding > 0 and loanSize > 0  and below strike:
    sell holding
    holding is 0
    short position

if holding >= loanSize and aboveStrike:
    long position

if holding = 0 and loanSize > 0 and below strike:
    short position

if shorting the coin:

    if market lower than strike but higher than lower
    buy order is at strike if not make it so

    if market lower than lower
    buy order is at lower if not make it sow

if longing the coin:

    if market higher than upper
    sell is at upper if not make it so

    if market higher than strike but lower than upper
    sell is at strike if not make it so

for every filled order
======================

if completed order is sell place buy immediately at price of completed order
if completed order is buy place sell immediately at price of completed order

*/
async function InitializePosition() {
    if (inprocess)
        return;
    inprocess = true;
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0 };
    let { result: { list: orders } } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    if (orders && orders.length > 1) {
        await cancelOrders(orders.map(o => o.orderId));
        orders = [];
    }
    let hasPendingSell = !!orders.find(order => order.side == "SELL");
    let hasPendingBuy = !!orders.find(order => order.side == "BUY");
    let totalHoldings = orders.map(o => o.side == "SELL" ? round(o.orderQty, 5) : 0).reduce((p, c) => p + c, 0) + round(position.free, 5);
    let borrowing = position.loan >= quantity;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    let loggedMessage = false;
    while (price > strikeLower && price < strikeUpper) {
        if (!loggedMessage) {
            console.log(`Price ${price} is between ${strikeLower} and ${strikeUpper} `);
            loggedMessage = true;
        }
        await asyncSleep(1000);
        ({ result: { price } } = await client.getLastTradedPrice(symbol));
    }
    let aboveStrike = price > strikeUpper;
    console.log(`borrowing: ${borrowing} aboveStrike: ${aboveStrike} holding: ${totalHoldings} sell: ${hasPendingSell} buy: ${hasPendingBuy} price: ${price} lower: ${strikeLower} upper: ${strikeUpper} `);
    if (!borrowing) {
        await borrowFunds(baseCurrency, quantity);
        let runway = round(Math.max(quantity * interest, 1) / price, 5);
        await immediateBuy(symbol, runway);
        totalHoldings += quantity;
    }
    if (aboveStrike && (totalHoldings < quantity)) {
        let buyAmount = round((quantity - totalHoldings), 5);
        await immediateBuy(symbol, buyAmount);
    }
    if (aboveStrike && !hasPendingSell) {
        await conditionalSell(baseCurrency, symbol, quantity, strikeUpper);
    }
    if (!aboveStrike && (totalHoldings > 0)) {
        await immediateSell(symbol, totalHoldings);
    }
    if (!aboveStrike && !hasPendingBuy) {
        await conditionalBuy(symbol, quantity, strikeLower);
    }
    inprocess = false;
}
try {
    process.stdin.on('data', process.exit.bind(process, 0));
    wsClient.on('update', message => {
        console.log(`update: ${message === null || message === void 0 ? void 0 : message.topic} `);
        runInitialize = true;
        // if (message?.topic != 'ticketInfo' || !message?.data?.length) return;
        // console.log(`snapshot: ${JSON.stringify(message, null, 2)} `);
        // const data = message.data[0];
        // strikePrice = Math.min(+data.p, strikePrice);
        // ({ strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage));
    });
    wsClient.subscribe(['ticketInfo'], true);
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