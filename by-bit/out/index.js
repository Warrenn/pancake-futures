var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, AccountAssetClient, USDCOptionClient, UnifiedMarginClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import dotenv from "dotenv";
dotenv.config();
const slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = `${process.env.BASE}${process.env.QUOTE}`, baseCurrency = `${process.env.BASE}`, quoteCurrency = `${process.env.QUOTE}`, tradeMargin = parseFloat(`${process.env.TRADE_MARGIN}`), quotePrecision = parseInt(`${process.env.QUOTE_PRECISION}`), basePrecision = parseInt(`${process.env.BASE_PRECISION}`), sidewaysLimit = parseInt(`${process.env.SIDEWAYS_LIMIT}`), authKey = `${process.env.AUTHPARAMKEY}`, tradeDataKey = `${process.env.TRADEDATAKEY}`, trailingPerc = parseFloat(`${process.env.TRAILING}`), targetROI = parseFloat(`${process.env.TARGET_ROI}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), leverage = parseInt(`${process.env.LEVERAGE}`), minSizes = {
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
let trailingDirection = "Up", trailingPrice = 0, newTrailing = 0, spotStrikePrice = 0, retryTimeout = 5000, initialEquity = 0, targetProfit = 0, lowerLimit = 0, upperLimit = 0, tradableEquity = 0, sideWaysCount = 0, quantity = 0, holdingPutOption = false, holdingCallOpton = false, putSymbol = "", callSymbol = "";
let client, optionsClient, assetsClient, unifiedClient;
function floor(num, precision = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
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
    let position = getPosition(loanAccountList, coin, precision);
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
    let position = getPosition(loanAccountList, coin, basePrecision);
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
}
function calculateNetEquity(basePosition, quotePosition, price) {
    let qouteTotal = quotePosition.free - quotePosition.loan;
    let baseTotal = (basePosition.free - basePosition.loan) * price;
    return qouteTotal + baseTotal;
}
async function settleAccount(position, price) {
    log(`Settling account free: ${position.free} loan: ${position.loan} price: ${price}`);
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
}
function getPosition(loanAccountList, tokenId, precision) {
    let position = loanAccountList.find(item => item.tokenId == tokenId) || { free: 0, loan: 0, tokenId };
    position.free = floor(position.free, precision);
    position.loan = floor(position.loan, precision);
    return position;
}
async function costOfSettling(putSymbol) {
    return 0;
    throw new Error("Function not implemented.");
}
async function settleOption(putSymbol) {
    throw new Error("Function not implemented.");
}
async function executeTrade() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, quotePrecision);
    let borrowing = position.loan >= quantity;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    price = floor(price, quotePrecision);
    if (holdingPutOption && (price < lowerLimit)) {
        spotStrikePrice = lowerLimit;
    }
    if (holdingCallOpton && (price > upperLimit)) {
        spotStrikePrice = upperLimit;
    }
    log(`holding:${position.free} onloan:${position.loan} price:${price} strike:${spotStrikePrice} direction:${trailingDirection} tp:${trailingPrice} sideways:${sideWaysCount} u:${upperLimit} l:${lowerLimit} hc:${holdingCallOpton} hp:${holdingPutOption}`);
    if (sideWaysCount > sidewaysLimit && !holdingCallOpton && !holdingPutOption) {
        log(`Trading sideways ${sideWaysCount}`);
        let netEquity = calculateNetEquity(position, quotePosition, price);
        tradableEquity = netEquity * tradeMargin;
        quantity = ((tradableEquity / 3) * leverage) / price;
        //transfer 2/3 of tradableEquituy to UNIFIED account
        //place the call and put options
        //get excess from unified account transferred to spot
        //reset the strike price back to 0
        await settleAccount(position, price);
        // let fundsForOptions = await calculateFundsForOptions(tradableEquity);
        // tradableEquity = netEquity - fundsForOptions;
        // quantity = floor(tradableEquity * spotLeverageCof, quotePrecision);
        //await moveFundsToOptions(fundsForOptions);
        //sell await callOption(quantity,callSymbol);
        //sell await putOption(quantity,putSymbol);
        //call limit upperLimit = price * (1 + breakout);
        //put limit lowerLimit = price * (1 - breakout);
        sideWaysCount = 0;
    }
    if (!borrowing) {
        let borrowAmount = floor(quantity - position.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        ({ result: { loanAccountList } } = await client.getCrossMarginAccountInfo());
        position = getPosition(loanAccountList, baseCurrency, basePrecision);
        quotePosition = getPosition(loanAccountList, quoteCurrency, quotePrecision);
    }
    if (spotStrikePrice == 0)
        spotStrikePrice = price;
    if (initialEquity == 0) {
        initialEquity = calculateNetEquity(position, quotePosition, price);
        tradableEquity = initialEquity * tradeMargin;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = tradableEquity * 4;
    }
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
        let netEquity = calculateNetEquity(position, quotePosition, price);
        let optionChanged = false;
        trailingPrice = newTrailing;
        if (holdingPutOption && trailingDirection == "Up") {
            let costOfSettlingPut = await costOfSettling(putSymbol);
            if (costOfSettlingPut > 0)
                return;
            await settleOption(putSymbol);
            putSymbol = '';
            holdingPutOption = false;
            optionChanged = true;
        }
        if (holdingCallOpton && trailingDirection == "Down") {
            let costOfSettlingCall = await costOfSettling(callSymbol);
            //if the costOfSettlingCall is 0 or net profit from settling is greater than 0 netprofit=netEquity - initialEquity - targetProfit
            if (costOfSettlingCall > 0)
                return;
            await settleOption(callSymbol);
            callSymbol = '';
            holdingCallOpton = false;
            optionChanged = true;
        }
        if (!holdingCallOpton && !holdingPutOption && optionChanged) {
            await rebalanceToSpot();
            await settleAccount(position, price);
            spotStrikePrice = 0;
            initialEquity = 0;
            return;
        }
        if (holdingCallOpton || holdingPutOption)
            return;
        let profit = netEquity - initialEquity - targetProfit;
        log(`netEquity:${netEquity} initialEquity:${initialEquity} targetProfit:${targetProfit} profit:${profit}`);
        if (profit > 0) {
            await settleAccount(position, price);
            spotStrikePrice = 0;
            initialEquity = 0;
            targetProfit = 0;
            sideWaysCount = 0;
            return;
        }
    }
    let netPosition = position.free - position.loan;
    let outOfMoneyCall = netPosition != 0 && holdingCallOpton && price < upperLimit;
    if ((outOfMoneyCall && !holdingPutOption) || (outOfMoneyCall && price > lowerLimit)) {
        await settleAccount(position, price);
        trailingDirection = "Down";
    }
    let outOfMoneyPut = netPosition != 0 && holdingPutOption && price > lowerLimit;
    if ((outOfMoneyPut && !holdingCallOpton) || (outOfMoneyPut && price < upperLimit)) {
        await settleAccount(position, price);
        trailingDirection = "Up";
    }
    let longAmount = quantity - netPosition;
    if ((price > spotStrikePrice) && (longAmount > 0) && (holdingCallOpton || !holdingPutOption)) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        trailingDirection = "Up";
        sideWaysCount++;
    }
    if ((price < spotStrikePrice) && (position.free > 0) && (holdingPutOption || !holdingCallOpton)) {
        let sellAmount = floor(position.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        trailingDirection = "Down";
        sideWaysCount++;
    }
}
async function rebalanceToSpot() {
    let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
    if (!coin || coin.length == 0 || coin[0].availableBalance == 0)
        return;
    let amount = floor(coin[0].availableBalance, quotePrecision);
    await assetsClient.createInternalTransfer({
        amount: `${amount}`,
        coin: quoteCurrency,
        from_account_type: "UNIFIED",
        to_account_type: "SPOT",
        transfer_id: `${uuid()}`
    });
}
process.stdin.on('data', process.exit.bind(process, 0));
await writeFile('errors.log', `Starting session ${(new Date()).toUTCString()}\r\n`, 'utf-8');
spotStrikePrice = 0;
initialEquity = 0;
targetProfit = 0;
sideWaysCount = 0;
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
        assetsClient = new AccountAssetClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });
        unifiedClient = new UnifiedMarginClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });
        let { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency });
        if ((list || []).length == 0)
            process.exit();
        //check if holding any option positions
        //at the start
        //when both put and call settle
        //after option expiry
        process.exit();
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Sell" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Sell" });
        retryTimeout = 5000;
        while (true) {
            //await asyncSleep(200);
            //check for option expiry 
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