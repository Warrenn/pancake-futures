var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, AccountAssetClient, USDCOptionClient, UnifiedMarginClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import dotenv from "dotenv";
dotenv.config();
const slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = `${process.env.BASE}${process.env.QUOTE}`, baseCurrency = `${process.env.BASE}`, quoteCurrency = `${process.env.QUOTE}`, tradeMargin = parseFloat(`${process.env.TRADE_MARGIN}`), optionPrecision = parseInt(`${process.env.OPTION_PRECISION}`), quotePrecision = parseInt(`${process.env.QUOTE_PRECISION}`), basePrecision = parseInt(`${process.env.BASE_PRECISION}`), sidewaysLimit = parseInt(`${process.env.SIDEWAYS_LIMIT}`), authKey = `${process.env.AUTHPARAMKEY}`, tradeDataKey = `${process.env.TRADEDATAKEY}`, trailingPerc = parseFloat(`${process.env.TRAILING}`), targetROI = parseFloat(`${process.env.TARGET_ROI}`), optionROI = parseFloat(`${process.env.OPTION_ROI}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), leverage = parseInt(`${process.env.LEVERAGE}`), months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], minSizes = {
    ETH: 0.08,
    NEAR: 1,
    USDT: 10,
    USDC: 10
};
let trailingDirection = "Up", trailingPrice = 0, newTrailing = 0, spotStrikePrice = 0, initialEquity = 0, targetProfit = 0, lowerLimit = 0, upperLimit = 0, tradableEquity = 0, sideWaysCount = 0, quantity = 0, holdingPutOption = false, holdingCallOpton = false, putSymbol = "", callSymbol = "", currentMoment, expiryTime = new Date();
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
async function settleOption(symbol) {
    let { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency, symbol });
    if (!list || list.length == 0)
        return false;
    let optionPosition = list[0];
    let entryPrice = parseFloat(optionPosition.entryPrice);
    let uPnl = parseFloat(optionPosition.unrealisedPnl);
    let size = Math.abs(parseFloat(optionPosition.size));
    let targetProfit = entryPrice * optionROI * size;
    if (uPnl < targetProfit)
        return false;
    log(`settling option  ${symbol} ${size} upnl:${uPnl} target:${targetProfit}`);
    while (true) {
        let { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            qty: `${size}`,
            orderType: "Market",
            side: "Buy",
            symbol: symbol,
            timeInForce: "ImmediateOrCancel",
            orderLinkId: `${uuid()}`,
            reduceOnly: true
        });
        if (retCode == 0)
            return true;
        logError(`settlement failed ${symbol} ${size} upnl:${uPnl} target:${targetProfit} (${retCode}) failed ${retMsg}`);
    }
}
async function placeStraddle(price, size) {
    lowerLimit = Math.floor(price / 25) * 25;
    upperLimit = lowerLimit + 25;
    expiryTime = new Date();
    expiryTime.setUTCDate(expiryTime.getUTCDate() + ((expiryTime.getUTCHours() < 8) ? 0 : 1));
    expiryTime.setUTCHours(8);
    expiryTime.setUTCMinutes(0);
    expiryTime.setUTCSeconds(0);
    expiryTime.setUTCMilliseconds(0);
    let yearStr = `${expiryTime.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);
    putSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${lowerLimit}-P`;
    callSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${upperLimit}-C`;
    while (true) {
        var { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            orderType: 'Market',
            side: 'Sell',
            qty: `${size}`,
            symbol: putSymbol,
            timeInForce: 'ImmediateOrCancel',
            orderLinkId: `${uuid()}`
        });
        if (retCode == 0)
            break;
        logError(`put order failed ${putSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);
    }
    while (true) {
        var { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            orderType: 'Market',
            qty: `${size}`,
            side: 'Sell',
            symbol: callSymbol,
            timeInForce: 'ImmediateOrCancel',
            orderLinkId: `${uuid()}`
        });
        if (retCode == 0)
            break;
        logError(`call order failed ${callSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);
    }
    holdingCallOpton = true;
    holdingPutOption = true;
    log(`Placed straddle at:${price} size:${size} `);
}
async function executeTrade() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, quotePrecision);
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    price = floor(price, quotePrecision);
    if (spotStrikePrice == 0)
        spotStrikePrice = price;
    if (initialEquity == 0 && !holdingCallOpton && !holdingPutOption) {
        initialEquity = calculateNetEquity(position, quotePosition, price);
        tradableEquity = initialEquity * tradeMargin;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = floor((tradableEquity * leverage) / price, basePrecision);
        trailingDirection = (position.free > position.loan) ? "Up" : "Down";
    }
    if (initialEquity == 0 && (holdingCallOpton || holdingPutOption)) {
        initialEquity = calculateNetEquity(position, quotePosition, price);
        let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
        tradableEquity = (!coin || coin.length == 0) ? 0 : floor(coin[0].equity, quotePrecision);
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = floor((tradableEquity * leverage) / price, optionPrecision);
        trailingDirection = (position.free > position.loan) ? "Up" : "Down";
    }
    let borrowing = position.loan >= quantity;
    log(`holding:${position.free} onloan:${position.loan} price:${price} strike:${spotStrikePrice} direction:${trailingDirection} tp:${trailingPrice} sideways:${sideWaysCount} u:${upperLimit} l:${lowerLimit} hc:${holdingCallOpton} hp:${holdingPutOption}`);
    if (!borrowing) {
        let borrowAmount = floor(quantity - position.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        ({ result: { loanAccountList } } = await client.getCrossMarginAccountInfo());
        position = getPosition(loanAccountList, baseCurrency, basePrecision);
        quotePosition = getPosition(loanAccountList, quoteCurrency, quotePrecision);
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
    if (sideWaysCount > sidewaysLimit && !holdingCallOpton && !holdingPutOption) {
        log(`Trading sideways ${sideWaysCount}`);
        let spotEquity = calculateNetEquity(position, quotePosition, price);
        let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
        let availiableUnified = (!coin || coin.length == 0) ? 0 : floor(coin[0].availableBalance, quotePrecision);
        tradableEquity = ((spotEquity + availiableUnified) * tradeMargin) / 2;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = floor((tradableEquity * leverage) / price, optionPrecision);
        await settleAccount(position, price);
        await splitEquity(tradableEquity - availiableUnified);
        await placeStraddle(price, quantity);
        spotStrikePrice = 0;
        sideWaysCount = 0;
        return;
    }
    if ((price < trailingPrice && trailingDirection == "Up") ||
        (price > trailingPrice && trailingDirection == "Down")) {
        let netEquity = calculateNetEquity(position, quotePosition, price);
        let optionChanged = false;
        trailingPrice = newTrailing;
        if (holdingPutOption && trailingDirection == "Up") {
            let optionSettled = await settleOption(putSymbol);
            if (optionSettled) {
                putSymbol = '';
                holdingPutOption = false;
                optionChanged = true;
            }
        }
        if (holdingCallOpton && trailingDirection == "Down") {
            let optionSettled = await settleOption(callSymbol);
            if (optionSettled) {
                callSymbol = '';
                holdingCallOpton = false;
                optionChanged = true;
            }
        }
        if (!holdingCallOpton && !holdingPutOption && optionChanged) {
            await settleAccount(position, price);
            await moveFundsToSpot();
            spotStrikePrice = 0;
            initialEquity = 0;
            sideWaysCount = 0;
            return;
        }
        let profit = netEquity - initialEquity - targetProfit;
        log(`netEquity:${netEquity} initialEquity:${initialEquity} targetProfit:${targetProfit} grossProfit:${(netEquity - initialEquity)}`);
        if (profit > 0 && !holdingCallOpton && !holdingPutOption) {
            await settleAccount(position, price);
            spotStrikePrice = 0;
            initialEquity = 0;
            targetProfit = 0;
            sideWaysCount = 0;
            return;
        }
    }
    let netPosition = floor(position.free - position.loan, basePrecision);
    if (netPosition != 0 &&
        holdingCallOpton &&
        price < upperLimit &&
        (!holdingPutOption || price > lowerLimit)) {
        await settleAccount(position, price);
        trailingDirection = "Down";
        return;
    }
    if (netPosition != 0 &&
        holdingPutOption &&
        price > lowerLimit &&
        (!holdingCallOpton || price < upperLimit)) {
        await settleAccount(position, price);
        trailingDirection = "Up";
        return;
    }
    if (holdingPutOption && price < lowerLimit && position.free > 0) {
        let sellAmount = floor(position.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        trailingDirection = "Down";
        return;
    }
    let longAmount = floor(quantity - netPosition, basePrecision);
    if (holdingCallOpton && price > upperLimit && longAmount > 0) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        trailingDirection = "Up";
        return;
    }
    if (holdingCallOpton || holdingPutOption)
        return;
    if ((price > spotStrikePrice) && (longAmount > 0)) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        trailingDirection = "Up";
        sideWaysCount++;
    }
    if ((price < spotStrikePrice) && (position.free > 0)) {
        let sellAmount = floor(position.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        trailingDirection = "Down";
        sideWaysCount++;
    }
}
function resetState() {
    spotStrikePrice = 0;
    initialEquity = 0;
    targetProfit = 0;
    sideWaysCount = 0;
    holdingCallOpton = false;
    holdingPutOption = false;
    putSymbol = '';
    callSymbol = '';
}
async function splitEquity(unifiedAmount) {
    unifiedAmount = floor(unifiedAmount, quotePrecision);
    if (unifiedAmount == 0)
        return;
    if (unifiedAmount > 0) {
        while (true) {
            var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
                amount: `${unifiedAmount}`,
                coin: quoteCurrency,
                from_account_type: "SPOT",
                to_account_type: "UNIFIED",
                transfer_id: `${uuid()}`
            });
            if (ret_code == 0)
                return;
            logError(`Failed to split Equity ${quoteCurrency} ${unifiedAmount} SPOT -> UNIFIED ${ret_msg}`);
        }
    }
    while (true) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${Math.abs(unifiedAmount)}`,
            coin: quoteCurrency,
            from_account_type: "UNIFIED",
            to_account_type: "SPOT",
            transfer_id: `${uuid()}`
        });
        if (ret_code == 0)
            return;
        logError(`Failed to split Equity ${quoteCurrency} ${Math.abs(unifiedAmount)} UNIFIED -> SPOT ${ret_msg}`);
    }
}
async function moveFundsToSpot() {
    let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
    if (!coin || coin.length == 0 || coin[0].availableBalance == 0)
        return;
    let amount = floor(coin[0].availableBalance, quotePrecision);
    while (true) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${amount}`,
            coin: quoteCurrency,
            from_account_type: "UNIFIED",
            to_account_type: "SPOT",
            transfer_id: `${uuid()}`
        });
        if (ret_code == 0)
            return;
        logError(`Failed to move funds to SPOT ${quoteCurrency} ${Math.abs(amount)} UNIFIED -> SPOT ${ret_msg}`);
    }
}
async function closeUnifiedAccount() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = getPosition(loanAccountList, baseCurrency, basePrecision);
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    price = floor(price, quotePrecision);
    await settleAccount(position, price);
    await moveFundsToSpot();
}
process.stdin.on('data', process.exit.bind(process, 0));
await writeFile('errors.log', `Starting session ${(new Date()).toUTCString()}\r\n`, 'utf-8');
resetState();
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
        if (!holdingCallOpton || !holdingPutOption) {
            let { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency });
            let checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`);
            for (let c = 0; c < (list || []).length; c++) {
                let optionPosition = list[c];
                let matches = optionPosition.symbol.match(checkExpression);
                if (!matches)
                    continue;
                if (matches[5] == 'P') {
                    holdingPutOption = true;
                    lowerLimit = parseFloat(matches[4]);
                    putSymbol = optionPosition.symbol;
                }
                if (matches[5] == 'C') {
                    holdingCallOpton = true;
                    upperLimit = parseFloat(matches[4]);
                    callSymbol = optionPosition.symbol;
                }
                let mIndex = months.indexOf(matches[2]);
                expiryTime = new Date();
                let newYear = parseInt(`${expiryTime.getUTCFullYear}`.substring(0, 2) + matches[3]);
                expiryTime.setUTCDate(parseInt(matches[1]));
                expiryTime.setUTCHours(8);
                expiryTime.setUTCMinutes(0);
                expiryTime.setUTCSeconds(0);
                expiryTime.setUTCMilliseconds(0);
                expiryTime.setUTCMonth(mIndex);
                expiryTime.setUTCFullYear(newYear);
            }
        }
        while (true) {
            await asyncSleep(200);
            currentMoment = new Date();
            if ((holdingCallOpton || holdingPutOption) && currentMoment > expiryTime) {
                await closeUnifiedAccount();
                resetState();
            }
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
    }
}
//# sourceMappingURL=index.js.map