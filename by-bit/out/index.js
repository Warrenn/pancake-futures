var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, AccountAssetClient, WebsocketClient, UnifiedMarginClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import dotenv from "dotenv";
dotenv.config();
const slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = `${process.env.BASE}${process.env.QUOTE}`, baseCurrency = `${process.env.BASE}`, quoteCurrency = `${process.env.QUOTE}`, tradeMargin = parseFloat(`${process.env.TRADE_MARGIN}`), optionPrecision = parseInt(`${process.env.OPTION_PRECISION}`), quotePrecision = parseInt(`${process.env.QUOTE_PRECISION}`), basePrecision = parseInt(`${process.env.BASE_PRECISION}`), sidewaysLimit = parseInt(`${process.env.SIDEWAYS_LIMIT}`), optionIM = parseFloat(`${process.env.OPTION_IM}`), authKey = `${process.env.AUTHPARAMKEY}`, tradeDataKey = `${process.env.TRADEDATAKEY}`, targetROI = parseFloat(`${process.env.TARGET_ROI}`), optionROI = parseFloat(`${process.env.OPTION_ROI}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), leverage = parseInt(`${process.env.LEVERAGE}`), months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], minSizes = {
    ETH: 0.08,
    NEAR: 1,
    USDT: 10,
    USDC: 10
};
let spotStrikePrice = 0, initialEquity = 0, targetProfit = 0, sideWaysCount = 0, upperLimit = 0, lowerLimit = 0, quantity = 0, currentMoment, expiryTime = null, client, assetsClient, unifiedClient, wsUnified = null, wsSpot = null, optionsNeedUpdate = false, positionsNeedUpdate = false, callSubscription = '', putSubscription = '', optionsTriggers = {}, callOption = null, putOption = null, basePosition, quotePosition, expiry = null, price;
function floor(num, precision = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}
async function immediateSell(symbol, orderQty, price, coin = baseCurrency) {
    orderQty = floor(orderQty, basePrecision);
    if (orderQty == 0)
        return;
    positionsNeedUpdate = true;
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
    if (orderQty == 0)
        return;
    positionsNeedUpdate = true;
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
    positionsNeedUpdate = true;
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
    positionsNeedUpdate = true;
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
    positionsNeedUpdate = true;
    if (position.free < position.loan) {
        let buyAmount = floor(position.loan - position.free, basePrecision);
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
async function settleOption(optionPosition, force = false) {
    if (!optionPosition)
        return false;
    let entryPrice = parseFloat(optionPosition.entryPrice);
    let uPnl = parseFloat(optionPosition.unrealisedPnl);
    let size = Math.abs(parseFloat(optionPosition.size));
    let targetProfit = entryPrice * optionROI * size;
    if (!force && uPnl < targetProfit)
        return false;
    log(`settling option  ${optionPosition.symbol} ${size} upnl:${uPnl} target:${targetProfit}`);
    optionsNeedUpdate = true;
    while (true) {
        let { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            qty: `${size}`,
            orderType: "Market",
            side: "Buy",
            symbol: optionPosition.symbol,
            timeInForce: "ImmediateOrCancel",
            orderLinkId: `${uuid()}`,
            reduceOnly: true
        });
        if (retCode == 110063)
            return false;
        if (retCode == 0)
            return true;
        logError(`settlement failed ${optionPosition.symbol} ${size} upnl:${uPnl} target:${targetProfit} (${retCode}) failed ${retMsg}`);
    }
}
async function placeStraddle(price, size) {
    let contractPrice = Math.floor(price / 25) * 25;
    let lowerLimit = (price % 25) < 12.5 ? contractPrice - 25 : contractPrice;
    let upperLimit = lowerLimit + 50;
    let expiryTime = new Date();
    expiryTime.setUTCDate(expiryTime.getUTCDate() + ((expiryTime.getUTCHours() < 8) ? 0 : 1));
    expiryTime.setUTCHours(8);
    expiryTime.setUTCMinutes(0);
    expiryTime.setUTCSeconds(0);
    expiryTime.setUTCMilliseconds(0);
    let yearStr = `${expiryTime.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);
    let putSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${lowerLimit}-P`;
    let callSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${upperLimit}-C`;
    log(`Placing straddle price:${price} size:${size} put:${putSymbol} call:${callSymbol}`);
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
    optionsNeedUpdate = true;
    return expiryTime;
}
async function getPositions() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let basePosition = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, basePrecision);
    return { basePosition, quotePosition };
}
async function reconcileLoan(basePosition, quantity, price) {
    if (basePosition.loan == quantity)
        return;
    positionsNeedUpdate = true;
    if (basePosition.loan < quantity) {
        let borrowAmount = floor(quantity - basePosition.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        return;
    }
    let repayment = floor(basePosition.loan - quantity, basePrecision);
    if (repayment == 0)
        return;
    if (repayment > basePosition.free) {
        let buyAmount = repayment - basePosition.free;
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
    }
    while (true) {
        let { retCode, retMsg } = await client.repayCrossMarginLoan(baseCurrency, `${repayment}`);
        if (retCode == 0 || retCode == 12000)
            return;
        logError(`couldn't reconcile loan:${basePosition.loan} free:${basePosition.free} quantity:${quantity} repayment:${repayment} (${retCode}) ${retMsg}`);
    }
}
function calculateState({ spotStrikePrice, initialEquity, targetProfit, quantity, basePosition, quotePosition, callOption, putOption, price }) {
    if (spotStrikePrice == 0)
        spotStrikePrice = price;
    if (initialEquity == 0 && !callOption && !putOption) {
        initialEquity = calculateNetEquity(basePosition, quotePosition, price);
        let tradableEquity = initialEquity * tradeMargin;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = floor((tradableEquity * leverage) / price, basePrecision);
    }
    if (initialEquity == 0 && (callOption || putOption)) {
        initialEquity = calculateNetEquity(basePosition, quotePosition, price);
        let option = callOption || putOption;
        quantity = Math.abs(parseFloat(`${option === null || option === void 0 ? void 0 : option.size}`));
    }
    return { spotStrikePrice, initialEquity, targetProfit, quantity };
}
async function executeTrade({ expiry, expiryTime, putOption, callOption, lowerLimit, upperLimit, spotStrikePrice, initialEquity, basePosition, quotePosition, targetProfit, quantity, sideWaysCount, price }) {
    if (expiryTime == null)
        expiryTime = expiry;
    if (lowerLimit == 0 && putOption)
        lowerLimit = putOption.limit;
    if (upperLimit == 0 && callOption)
        upperLimit = callOption.limit;
    let netEquity = calculateNetEquity(basePosition, quotePosition, price);
    let profit = netEquity - initialEquity - targetProfit;
    log(`f:${basePosition.free} l:${basePosition.loan} p:${price} q:${quantity} skp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} e:${expiryTime === null || expiryTime === void 0 ? void 0 : expiryTime.toISOString()} u:${upperLimit} l:${lowerLimit} c:${callOption === null || callOption === void 0 ? void 0 : callOption.unrealisedPnl} p:${putOption === null || putOption === void 0 ? void 0 : putOption.unrealisedPnl}`);
    if (sideWaysCount > sidewaysLimit) {
        log(`Trading sideways ${sideWaysCount}`);
        await settleOption(putOption, true);
        await settleOption(callOption, true);
        let spotEquity = calculateNetEquity(basePosition, quotePosition, price);
        let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
        let availiableUnified = (!coin || coin.length == 0) ? 0 : floor(coin[0].availableBalance, quotePrecision);
        let equity = (spotEquity + availiableUnified);
        let tradableEquity = equity * tradeMargin;
        quantity = floor((tradableEquity * leverage) / ((1 + optionIM) * price), optionPrecision);
        let requiredMargin = price * quantity * optionIM;
        await settleAccount(basePosition, price);
        await splitEquity(requiredMargin);
        expiryTime = await placeStraddle(price, quantity);
        await reconcileLoan(basePosition, quantity, price);
        positionsNeedUpdate = true;
        spotStrikePrice = 0;
        sideWaysCount = 0;
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    }
    if (await settleOption(putOption))
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    if (await settleOption(callOption))
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    let netPosition = floor(basePosition.free - basePosition.loan, basePrecision);
    if (expiryTime && !callOption && !putOption && netPosition != 0) {
        await settleAccount(basePosition, price);
        await moveFundsToSpot();
        spotStrikePrice = 0;
        initialEquity = 0;
        sideWaysCount = 0;
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    }
    if (expiryTime && !callOption && !putOption)
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    if ((callOption || putOption) &&
        netPosition != 0 &&
        price < upperLimit &&
        price > lowerLimit) {
        await settleAccount(basePosition, price);
        sideWaysCount++;
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    }
    if (putOption && price < lowerLimit && basePosition.free > 0) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        sideWaysCount++;
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    }
    let longAmount = floor(quantity - netPosition, basePrecision);
    if (callOption && price > upperLimit && longAmount > 0) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        sideWaysCount++;
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    }
    if (callOption || putOption)
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    if (profit > 0) {
        await settleAccount(basePosition, price);
        await moveFundsToSpot();
        spotStrikePrice = 0;
        initialEquity = 0;
        targetProfit = 0;
        sideWaysCount = 0;
        return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
    }
    if ((price > spotStrikePrice) && (longAmount > 0)) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        sideWaysCount++;
    }
    if ((price < spotStrikePrice) && (basePosition.free > 0)) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        sideWaysCount++;
    }
    return { expiryTime, lowerLimit, upperLimit, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount };
}
async function splitEquity(unifiedAmount) {
    unifiedAmount = floor(unifiedAmount, quotePrecision);
    if (unifiedAmount == 0)
        return;
    positionsNeedUpdate = true;
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
async function getOptions() {
    let { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency }), checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`), callOption = null, putOption = null, expiry = null;
    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = list[c];
        let matches = optionPosition.symbol.match(checkExpression);
        let entryPrice = parseFloat(optionPosition.entryPrice);
        let triggerAmount = entryPrice - (entryPrice * optionROI);
        optionsTriggers[`tickers.${optionPosition.symbol}`] = triggerAmount;
        if (!matches)
            continue;
        if (parseFloat(optionPosition.size) == 0)
            continue;
        optionPosition.limit = parseFloat(matches[4]);
        if (matches[5] == 'P')
            putOption = optionPosition;
        if (matches[5] == 'C')
            callOption = optionPosition;
        if (expiry != null)
            continue;
        let mIndex = months.indexOf(matches[2]);
        expiry = new Date();
        let newYear = parseInt(`20${matches[3]}`);
        expiry.setUTCDate(parseInt(matches[1]));
        expiry.setUTCHours(8);
        expiry.setUTCMinutes(0);
        expiry.setUTCSeconds(0);
        expiry.setUTCMilliseconds(0);
        expiry.setUTCMonth(mIndex);
        expiry.setUTCFullYear(newYear);
    }
    return { callOption, putOption, expiry };
}
async function moveFundsToSpot() {
    //fix available balance running low
    let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
    if (!coin || coin.length == 0 || coin[0].availableBalance == 0)
        return;
    let amount = floor(coin[0].availableBalance, quotePrecision) - 1;
    positionsNeedUpdate = true;
    if (amount <= 0)
        return;
    while (true) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${amount}`,
            coin: quoteCurrency,
            from_account_type: "UNIFIED",
            to_account_type: "SPOT",
            transfer_id: `${uuid()}`
        });
        if (ret_code == 0 || ret_code == 10006 || ret_code == 90001)
            return;
        logError(`Failed to move funds to SPOT ${quoteCurrency} ${Math.abs(amount)} UNIFIED -> SPOT ${ret_code} ${ret_msg}`);
    }
}
function closeWebSocket(socket) {
    try {
        if (socket == null)
            return;
        socket.closeAll(true);
    }
    catch (err) {
        logError(`couldnt close socket: ${err}`);
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
        wsUnified = new WebsocketClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            fetchTimeOffsetBeforeAuth: true,
            market: 'unifiedOption'
        });
        wsUnified.on('update', (data) => {
            optionsNeedUpdate = optionsNeedUpdate || ((data === null || data === void 0 ? void 0 : data.topic) in optionsTriggers && parseFloat(data.data.markPrice) <= optionsTriggers[data.topic]);
        });
        wsSpot = new WebsocketClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            fetchTimeOffsetBeforeAuth: true,
            market: 'spotv3'
        });
        wsSpot.on('update', (data) => {
            var _a, _b;
            if ((data === null || data === void 0 ? void 0 : data.topic) == 'outboundAccountInfo')
                positionsNeedUpdate = true;
            if ((data === null || data === void 0 ? void 0 : data.topic) == `bookticker.${symbol}` && ((_a = data.data) === null || _a === void 0 ? void 0 : _a.ap))
                price = floor((_b = data.data) === null || _b === void 0 ? void 0 : _b.ap, quotePrecision);
        });
        wsSpot.subscribe(['outboundAccountInfo', `bookticker.${symbol}`]);
        ({ basePosition, quotePosition } = await getPositions());
        ({ callOption, putOption, expiry } = await getOptions());
        while (true) {
            var { result: { price: p }, retCode, retMsg } = await client.getLastTradedPrice(symbol);
            price = floor(p, quotePrecision);
            if (isNaN(price))
                continue;
            if (retCode == 0)
                break;
            logError(`Failed getting price (${retCode}) ${retMsg}`);
        }
        ({ initialEquity, quantity, spotStrikePrice, targetProfit } = calculateState({ spotStrikePrice, targetProfit, basePosition, callOption, initialEquity, price, putOption, quantity, quotePosition }));
        await reconcileLoan(basePosition, quantity, price);
        while (true) {
            await asyncSleep(100);
            currentMoment = new Date();
            if (expiryTime && currentMoment > expiryTime) {
                spotStrikePrice = 0;
                initialEquity = 0;
                targetProfit = 0;
                sideWaysCount = 0;
                expiryTime = null;
                lowerLimit = 0;
                upperLimit = 0;
                await settleAccount(basePosition, price);
                await moveFundsToSpot();
            }
            if (positionsNeedUpdate) {
                ({ basePosition, quotePosition } = await getPositions());
                positionsNeedUpdate = false;
            }
            if (optionsNeedUpdate) {
                ({ callOption, putOption, expiry } = await getOptions());
                optionsNeedUpdate = false;
            }
            ({ initialEquity, quantity, spotStrikePrice, targetProfit } = calculateState({ spotStrikePrice, targetProfit, basePosition, callOption, initialEquity, price, putOption, quantity, quotePosition }));
            ({ expiryTime, initialEquity, lowerLimit, quantity, sideWaysCount, spotStrikePrice, targetProfit, upperLimit } = await executeTrade({ basePosition, callOption, expiry, expiryTime, initialEquity, lowerLimit, price, putOption, quantity, quotePosition, sideWaysCount, spotStrikePrice, targetProfit, upperLimit }));
            if (callOption && callSubscription == '') {
                callSubscription = callOption.symbol;
                wsUnified.subscribe([`tickers.${callSubscription}`]);
            }
            if (putOption && putSubscription == '') {
                putSubscription = putOption.symbol;
                wsUnified.subscribe([`tickers.${putSubscription}`]);
            }
            if (!callOption && callSubscription != '') {
                wsUnified.unsubscribe([`tickers.${callSubscription}`]);
                callSubscription = '';
            }
            if (!putOption && putSubscription != '') {
                wsUnified.unsubscribe([`tickers.${putSubscription}`]);
                putSubscription = '';
            }
        }
    }
    catch (err) {
        try {
            await logError(`${err}`);
            closeWebSocket(wsUnified);
            closeWebSocket(wsSpot);
        }
        catch (lerr) {
            console.error(lerr);
        }
    }
}
//# sourceMappingURL=index.js.map