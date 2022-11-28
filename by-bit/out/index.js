var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, USDCOptionClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import dotenv from "dotenv";
dotenv.config();
const slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = `${process.env.BASE}${process.env.QUOTE}`, baseCurrency = `${process.env.BASE}`, quoteCurrency = `${process.env.QUOTE}`, quantity = parseFloat(`${process.env.QUANTITY}`), quotePrecision = parseInt(`${process.env.QUOTEPRECISION}`), basePrecision = parseInt(`${process.env.BASEPRECISION}`), straddleSize = parseFloat(`${process.env.STRADDLESIZE}`), authKey = `${process.env.AUTHPARAMKEY}`, tradeDataKey = `${process.env.TRADEDATAKEY}`, trailingPerc = parseFloat(`${process.env.TRAILING}`), targetROI = parseFloat(`${process.env.TARGETROI}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), straddleTimeConfig = getStraddleTimeConfig(`${process.env.STRADDLETIME}`), minSizes = {
    ETH: 0.08,
    NEAR: 1,
    USDT: 10,
    USDC: 10
};
// authentication (fetched securely):
//  apikey
//  secret
// daily change (fetched from a source):
//  quantity
//  option strike price
// strategy change (can be provided and will remain constant for the lifetime of the run):
//  slippage
//  quoteCurrency
//  openWithOptions
//  closeWithOptions
//  quoteprecision
//  baseprecision
//  baseCurrency
//  trailingPerc
let strikePrice = parseFloat(`${process.env.STRIKEPRICE}`), currentMoment = new Date(), trailingDirection = "Up", trailingPrice = 0, newTrailing = 0, spotStrikePrice = 0, retryTimeout = 5000, initialEquity = 0, targetProfit = 0, tradingHalted = false, straddlePlaced = false;
let client, assetClient, optionsClient;
function floor(num, precision = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}
function getStraddleTimeConfig(config) {
    var parts = config.split(':');
    return { hours: parseInt(parts[0]), minutes: parseInt(parts[1]) };
}
async function immediateSell(symbol, orderQty, price, coin = baseCurrency) {
    orderQty = floor(orderQty, basePrecision);
    while (true) {
        price = floor(price, quotePrecision);
        log(`immediate sell qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
            side: "Sell",
            symbol: symbol,
            timeInForce: "IOC"
        });
        if (orderResponse.retCode == 12229) {
            await logError(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = floor(orderQty, basePrecision);
            ({ result: { price } } = await client.getLastTradedPrice(symbol));
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
async function immediateBuy(symbol, orderQty, price, quoteCoin = quoteCurrency) {
    orderQty = floor(orderQty, basePrecision);
    while (true) {
        price = floor(price, quotePrecision);
        log(`immediate buy qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
            side: "Buy",
            symbol: symbol,
            timeInForce: "IOC"
        });
        if (orderResponse.retCode == 12228) {
            await logError(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * price, quotePrecision);
            ({ result: { price } } = await client.getLastTradedPrice(symbol));
            continue;
        }
        if (orderResponse.retCode == 0)
            return;
        await logError(orderResponse.retMsg);
        return;
    }
}
async function borrowIfRequired(coin, quantity, precision = quotePrecision) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`borrowIfRequired ${response.retMsg}`);
        return;
    }
    let { result: { loanAccountList } } = response;
    let position = loanAccountList.find(loanItem => loanItem.tokenId == coin) || { free: 0, loan: 0 };
    log(`borrowIfRequired free:${position.free} quantity: ${quantity}`);
    if (position.free >= quantity)
        return;
    let diff = floor(quantity - position.free, precision);
    if (diff == 0)
        return;
    await borrowFunds(coin, diff);
}
async function getSellableAmount(coin, quantity) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`getSellableAmount ${response.retMsg}`);
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
function calculateNetEquity(positions, price) {
    let quotePosition = positions.find(p => p.tokenId == quoteCurrency) || { free: 0, loan: 0 };
    let qouteTotal = quotePosition.free - quotePosition.loan;
    let basePosition = positions.find(p => p.tokenId == baseCurrency) || { free: 0, loan: 0 };
    let baseTotal = (basePosition.free * price) - (quotePosition.loan * price);
    return qouteTotal + baseTotal;
}
async function settleAccount(position, price) {
    if (position.free < position.loan) {
        let buyAmount = floor(position.loan - position.free, basePrecision);
        ;
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
    }
    if (position.free > position.loan) {
        let sellAmount = floor(position.free - position.loan, basePrecision);
        ;
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
    }
    await client.repayCrossMarginLoan(baseCurrency, `${position.loan}`);
}
async function placeClosingStraddle(settlementDate, size) {
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    let contractPrice = Math.floor(price / 25) * 25;
    let lowerStrike = (price % 25) < 12.5 ? contractPrice - 25 : contractPrice;
    let higherStrike = lowerStrike + 50;
    let dateStr = `0${settlementDate.getUTCDate()}`;
    dateStr = dateStr.substring(dateStr.length - 2);
    let yearStr = `${settlementDate.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);
    let putSymbol = `${baseCurrency}-${dateStr}${months[settlementDate.getUTCMonth()]}${yearStr}-${lowerStrike}-P`;
    let callSymbol = `${baseCurrency}-${dateStr}${months[settlementDate.getUTCMonth()]}${yearStr}-${higherStrike}-C`;
    var { result: putPosition, retCode, retMsg } = await optionsClient.getSymbolTicker(putSymbol);
    if (retCode != 0) {
        logError(`get option ${putSymbol} (${retCode}) failed ${retMsg}`);
        return;
    }
    var { result: callPosition, retCode, retMsg } = await optionsClient.getSymbolTicker(callSymbol);
    if (retCode != 0) {
        logError(`get option ${callSymbol} (${retCode}) failed ${retMsg}`);
        return;
    }
    let markTotal = +putPosition.markPrice + +callPosition.markPrice;
    if (isNaN(markTotal)) {
        logError(`invalid return values put: ${JSON.stringify(putPosition)} and call: ${JSON.stringify(callPosition)}!`);
        return;
    }
    let putSize = floor(size * (+callPosition.markPrice / markTotal), 2);
    let callSize = floor(size * (+putPosition.markPrice / markTotal), 2);
    var { retCode, retMsg } = await optionsClient.submitOrder({
        orderQty: `${putSize}`,
        orderType: "Market",
        side: "Buy",
        symbol: putSymbol,
        timeInForce: "ImmediateOrCancel",
        orderLinkId: `${uuid()}`
    });
    if (retCode != 0) {
        logError(`put order failed ${putSymbol} ${putSize} (${retCode}) failed ${retMsg}`);
        return;
    }
    var { retCode, retMsg } = await optionsClient.submitOrder({
        orderQty: `${size}`,
        orderType: "Market",
        side: "Buy",
        symbol: callSymbol,
        timeInForce: "ImmediateOrCancel",
        orderLinkId: `${uuid()}`
    });
    if (retCode != 0) {
        logError(`call order failed ${callSymbol} ${callSize} (${retCode}) failed ${retMsg}`);
    }
}
async function executeTrade() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0, tokenId: baseCurrency };
    position.free = floor(position.free, basePrecision);
    position.loan = floor(position.loan, basePrecision);
    let borrowing = position.loan >= quantity;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    log(`holding:${position.free} onloan:${position.loan} price:${price} strike:${spotStrikePrice} trailingDirection:${trailingDirection} trailingPrice:${trailingPrice}`);
    if (!borrowing) {
        let borrowAmount = floor(quantity - position.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        ({ result: { loanAccountList } } = await client.getCrossMarginAccountInfo());
        position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0, tokenId: baseCurrency };
        position.free = floor(position.free, basePrecision);
        position.loan = floor(position.loan, basePrecision);
    }
    if (spotStrikePrice == 0)
        spotStrikePrice = price;
    if (initialEquity == 0)
        initialEquity = calculateNetEquity(loanAccountList, price);
    if (targetProfit == 0)
        targetProfit = spotStrikePrice * quantity * targetROI;
    if (trailingDirection == "Up") {
        newTrailing = floor((price * (1 - trailingPerc)), quotePrecision);
        if (trailingPrice == 0)
            trailingPrice = newTrailing;
        trailingPrice = Math.max(trailingPrice, newTrailing);
    }
    else {
        newTrailing = floor((price * (1 + trailingPerc)), quotePrecision);
        if (trailingPrice == 0)
            trailingPrice = newTrailing;
        trailingPrice = Math.min(trailingPrice, newTrailing);
    }
    if ((price < trailingPrice && trailingDirection == "Up") ||
        (price > trailingPrice && trailingDirection == "Down")) {
        let netEquity = calculateNetEquity(loanAccountList, price);
        let profit = netEquity - initialEquity - targetProfit;
        log(`netEquity:${netEquity} initialEquity:${initialEquity} targetProfit:${targetProfit} profit:${profit}`);
        if (profit > 0) {
            await settleAccount(position, price);
            tradingHalted = true;
            return;
        }
        trailingPrice = newTrailing;
    }
    let longAmount = quantity - (position.free - position.loan);
    if ((price > spotStrikePrice) && (longAmount > 0)) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        trailingDirection = "Up";
    }
    if ((price < spotStrikePrice) && (position.free > 0)) {
        let sellAmount = floor(position.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        trailingDirection = "Down";
    }
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
        optionsClient = new USDCOptionClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });
        // let tid = `${uuid()}`;
        // let transfres = await assetClient.createInternalTransfer({
        //     amount: '1',
        //     from_account_type: "SPOT",
        //     to_account_type: "UNIFIED",
        //     coin: "USDC",
        //     transfer_id: tid
        // });
        // let oo = await optionsClient.getPositions(
        //     {
        //         category: "OPTION",
        //         symbol: 'ETH-24NOV22-1150-P'
        //     });
        // expirytime is for today if the current time in UTC is earlier than 8 am otherwise its for tomorrow
        currentMoment = new Date();
        let extraDay = 1;
        if (currentMoment.getUTCHours() < 8)
            extraDay = 0;
        let expiryTime = new Date();
        expiryTime.setDate(expiryTime.getDate() + extraDay);
        expiryTime.setUTCHours(8);
        expiryTime.setMinutes(0);
        expiryTime.setSeconds(0);
        expiryTime.setMilliseconds(0);
        let straddleMoment = new Date();
        straddleMoment.setDate(straddleMoment.getDate() + extraDay);
        straddleMoment.setHours(straddleTimeConfig.hours);
        straddleMoment.setMinutes(straddleTimeConfig.minutes);
        straddleMoment.setSeconds(0);
        straddleMoment.setMilliseconds(0);
        await placeClosingStraddle(expiryTime, 0.2);
        break;
        spotStrikePrice = 0;
        initialEquity = 0;
        targetProfit = 0;
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Sell" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Sell" });
        retryTimeout = 5000;
        while (true) {
            await asyncSleep(200);
            if (currentMoment > expiryTime)
                break;
            if (currentMoment > straddleMoment && !straddlePlaced) {
                await placeClosingStraddle(expiryTime, straddleSize);
                straddlePlaced = true;
                continue;
            }
            if (tradingHalted)
                continue;
            await executeTrade();
        }
    }
    catch (err) {
        try {
            await logError(`${err}`);
        }
        catch (lerr) {
            console.error(lerr);
        }
        await asyncSleep(retryTimeout);
        retryTimeout *= 2;
        if (retryTimeout > 3600000)
            retryTimeout = 3600000;
    }
}
//# sourceMappingURL=index.js.map