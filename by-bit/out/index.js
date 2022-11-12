var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3 } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import dotenv from "dotenv";
dotenv.config();
const interest = 0.0015, slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = 'ETHUSDT', baseCurrency = 'ETH', quoteCurrency = 'USDT', quantity = parseFloat(`${process.env.QUANTITY}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), minSizes = {
    ETH: 0.0005,
    USDT: 10
};
let strikePrice = parseFloat(`${process.env.STRIKEPRICE}`), inprocess = false, runInitialize = true, { strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage);
let client;
function setStrikeBoundries(strikePrice, slippage) {
    let strikeLower = round(strikePrice * (1 - slippage), 2), strikeUpper = round(strikePrice * (1 + slippage), 2);
    return { strikeLower, strikeUpper };
}
function round(num, precision = 2) {
    return +(Math.round(+(num + `e+${precision}`)) + `e-${precision}`);
}
async function immediateSell(symbol, orderQty, coin = baseCurrency) {
    orderQty = round(orderQty, 5);
    runInitialize = true;
    while (true) {
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        log(`immediate sell qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: price,
            side: "Sell",
            symbol: symbol,
            timeInForce: "FOK"
        });
        if (orderResponse.retCode == 12229) {
            await logError(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = round(orderQty, 5);
            if (orderQty > 0)
                continue;
            return;
        }
        if (orderResponse.retCode == 0)
            return;
        await logError(orderResponse.retMsg);
        return;
    }
}
async function immediateBuy(symbol, orderQty, quoteCoin = quoteCurrency) {
    orderQty = round(orderQty, 5);
    runInitialize = true;
    while (true) {
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        log(`immediate buy qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: price,
            side: "Buy",
            symbol: symbol,
            timeInForce: "FOK"
        });
        if (orderResponse.retCode == 12228) {
            await logError(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * price, 2);
            continue;
        }
        if (orderResponse.retCode == 0)
            return;
        await logError(orderResponse.retMsg);
        return;
    }
}
async function borrowIfRequired(coin, quantity, precision = 2) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`borrowIfRequired ${response.retMsg}`);
        runInitialize = true;
        return;
    }
    let { result: { loanAccountList } } = response;
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    log(`borrowIfRequired free:${position.free} quantity: ${quantity}`);
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
        await logError(`getSellableAmount ${response.retMsg}`);
        runInitialize = true;
        return quantity;
    }
    let { result: { loanAccountList } } = response;
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    return Math.min(quantity, position.free);
}
async function borrowFunds(coin, quantity) {
    if (!!minSizes[coin] && quantity < minSizes[coin])
        quantity = minSizes[coin];
    log(`borrow ${coin} ${quantity}`);
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);
    if (borrowResponse.retCode == 0)
        return;
    await logError(`borrowFunds ${borrowResponse.retMsg}`);
    runInitialize = true;
}
function log(message) {
    let logLine = `${(new Date()).toISOString()} ${message}`;
    console.log(logLine);
    writeFileSync('logs.log', logLine, 'utf-8');
}
async function consoleAndFile(message) {
    console.error(message);
    await appendFile('errors.log', message + '\r\n', 'utf-8');
}
async function logError(message) {
    await consoleAndFile((new Date()).toISOString());
    await consoleAndFile(message);
    var { result: { loanAccountList }, retCode, retMsg } = await client.getCrossMarginAccountInfo();
    if (retCode == 0) {
        await consoleAndFile('Account Info:');
        for (let position of loanAccountList) {
            await consoleAndFile(`Token ${position.tokenId} free: ${position.free} loan: ${position.loan} locked: ${position.locked} total: ${position.total}`);
        }
    }
    else {
        await consoleAndFile(`Account info failure ${retMsg}`);
    }
    var { result: { list: orders }, retCode, retMsg } = await client.getOpenOrders(symbol, undefined, undefined, 1);
    if (retCode == 0) {
        await consoleAndFile('Stop Orders:');
        for (let order of orders) {
            await consoleAndFile(`${order.orderId} ${order.side} ${order.status} op:${order.orderPrice} q:${order.orderQty} tp:${order.triggerPrice}`);
        }
    }
    else {
        await consoleAndFile(`Stop Orders failure ${retMsg}`);
    }
    var { result: { list: orders }, retCode, retMsg } = await client.getOpenOrders(symbol, undefined, undefined, 0);
    if (retCode == 0) {
        await consoleAndFile('Non SP Orders:');
        for (let order of orders) {
            await consoleAndFile(`${order.orderId} ${order.side} ${order.status} op:${order.orderPrice} ap:${order.avgPrice} q:${order.orderQty} eq:${order.execQty}`);
        }
    }
    else {
        await consoleAndFile(`Non SP Orders failure ${retMsg}`);
    }
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
    await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Buy" });
    await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Sell" });
    await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Buy" });
    await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Sell" });
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0 };
    position.free = round(position.free, 5);
    position.loan = round(position.loan, 5);
    let borrowing = position.loan >= quantity;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    if (price > strikeUpper)
        strikePrice = strikeUpper;
    if (price < strikeLower)
        strikePrice = strikeLower;
    let aboveStrike = price > strikePrice;
    log(`borrowing: ${borrowing} aboveStrike: ${aboveStrike} holding: ${position.free} onloan: ${position.loan} price: ${price} lower: ${strikeLower} upper: ${strikeUpper} strike: ${strikePrice}`);
    if (position.free > position.loan) {
        let adjustAmount = round(position.free - position.loan, 5);
        await immediateSell(symbol, adjustAmount);
    }
    if (!borrowing) {
        let borrowAmount = round(quantity - position.loan, 5);
        await borrowFunds(baseCurrency, borrowAmount);
        let runway = round(Math.max(quantity * interest, 1) / price, 5);
        await immediateBuy(symbol, runway);
        ({ result: { loanAccountList } } = await client.getCrossMarginAccountInfo());
        (position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0 });
        position.free = round(position.free, 5);
        position.loan = round(position.loan, 5);
    }
    if (aboveStrike && (position.free < quantity)) {
        let buyAmount = round((quantity - position.free), 5);
        await immediateBuy(symbol, buyAmount);
    }
    if (!aboveStrike && (position.free > 0)) {
        await immediateSell(symbol, position.free);
    }
    inprocess = false;
}
process.stdin.on('data', process.exit.bind(process, 0));
await writeFile('errors.log', `Starting session ${(new Date()).toUTCString()}\r\n`, 'utf-8');
while (true) {
    try {
        client = new SpotClientV3({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });
        while (true) {
            if (!runInitialize) {
                await asyncSleep(1000);
                await InitializePosition();
            }
            runInitialize = false;
            await InitializePosition();
        }
    }
    catch (err) {
        await logError(`${err}`);
    }
}
//# sourceMappingURL=index.js.map