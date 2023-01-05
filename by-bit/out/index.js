var _a, _b;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import AWS from 'aws-sdk';
import dotenv from "dotenv";
dotenv.config({ override: true });
const minSizes = {
    ETH: 0.08,
    NEAR: 1,
    USDT: 10,
    USDC: 10
}, credentialsKey = `${process.env.BYBIT_API_CREDENTIALS}`, settingsKey = `${process.env.BYBIT_SETTINGS}`, region = `${process.env.BYBIT_REGION}`;
let slippage = 0, symbol = '', baseCurrency = '', quoteCurrency = '', targetROI = 0, tradeMargin = 0, quotePrecision = 0, basePrecision = 0, logFrequency = 0, useTestnet = false, leverage = 0;
let targetProfit = 0, initialEquity = 0, sessionEquity = 0, strikePrice = 0, size = 0, client, wsSpot = null, positionsNeedUpdate = false, basePosition, quotePosition, bidPrice = 0, askPrice = 0, logCount = 0, ssm = null;
function floor(num, precision = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}
async function immediateSell(symbol, orderQty, price, coin = baseCurrency) {
    orderQty = floor(orderQty, basePrecision);
    if (orderQty <= (minSizes[coin] || 0))
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
    if (orderQty <= ((minSizes[quoteCurrency] || 0) / price))
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
async function log(message) {
    let logLine = `${(new Date()).toISOString()} ${message}`;
    console.log(logLine);
}
async function consoleAndFile(message) {
    console.log(message);
    console.error(message);
}
async function logError(message) {
    await consoleAndFile((new Date()).toISOString());
    await consoleAndFile(message);
}
function calculateNetEquity(basePosition, quotePosition, price) {
    let qouteTotal = quotePosition.free - quotePosition.loan;
    let baseTotal = (basePosition.free - basePosition.loan) * price;
    return floor(qouteTotal + baseTotal, quotePrecision);
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
async function getPositions() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let basePosition = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, basePrecision);
    return { basePosition, quotePosition };
}
async function reconcileLoan(basePosition, quantity, price) {
    if (Math.abs(basePosition.loan - quantity) < 0.001)
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
async function executeTrade({ size, basePosition, quotePosition, initialEquity, sessionEquity, strikePrice, targetProfit, askPrice, bidPrice }) {
    if (strikePrice == 0)
        strikePrice = (bidPrice + askPrice) / 2;
    if (sessionEquity == 0)
        sessionEquity = initialEquity;
    let price = (basePosition.free > 0) ? bidPrice : askPrice;
    let netEquity = calculateNetEquity(basePosition, quotePosition, price);
    let sessionProfit = netEquity - sessionEquity - targetProfit;
    if ((logCount % logFrequency) == 0) {
        log(`f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity}`);
        logCount = 1;
    }
    else
        logCount++;
    if ((askPrice > strikePrice && bidPrice < strikePrice) ||
        (sessionProfit > 0)) {
        settleAccount(basePosition, bidPrice);
        sessionEquity = netEquity;
        strikePrice = (bidPrice + askPrice) / 2;
        log(`settle f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity} ssp:${sessionProfit}`);
        return { sessionEquity, strikePrice };
    }
    let netBasePosition = floor(basePosition.free - basePosition.loan, basePrecision);
    let longAmount = floor(size - netBasePosition, basePrecision);
    if (bidPrice > strikePrice && longAmount > 0.001) {
        let buyPrice = floor(strikePrice * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, longAmount, buyPrice);
        log(`long f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity}`);
        return { sessionEquity, strikePrice };
    }
    if (askPrice < strikePrice && basePosition.free > 0) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(strikePrice * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        log(`short f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity}`);
    }
    return { sessionEquity, strikePrice };
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
ssm = new AWS.SSM({ region });
let authenticationParameter = await ssm.getParameter({ Name: credentialsKey, WithDecryption: true }).promise();
const { key, secret } = JSON.parse(`${(_a = authenticationParameter.Parameter) === null || _a === void 0 ? void 0 : _a.Value}`);
let settingsParameter = await ssm.getParameter({ Name: settingsKey }).promise();
({
    slippage, baseCurrency, quoteCurrency, leverage, targetROI,
    tradeMargin, quotePrecision, basePrecision, logFrequency, useTestnet
} = JSON.parse(`${(_b = settingsParameter.Parameter) === null || _b === void 0 ? void 0 : _b.Value}`));
symbol = `${baseCurrency}${quoteCurrency}`;
while (true) {
    try {
        client = new SpotClientV3({
            testnet: useTestnet,
            key: key,
            secret: secret,
            recv_window: 999999
        });
        wsSpot = new WebsocketClient({
            testnet: useTestnet,
            key: key,
            secret: secret,
            fetchTimeOffsetBeforeAuth: true,
            market: 'spotv3'
        });
        wsSpot.on('update', (data) => {
            var _a, _b, _c, _d;
            if ((data === null || data === void 0 ? void 0 : data.topic) == 'outboundAccountInfo')
                positionsNeedUpdate = true;
            if ((data === null || data === void 0 ? void 0 : data.topic) == `bookticker.${symbol}` && ((_a = data.data) === null || _a === void 0 ? void 0 : _a.ap) && ((_b = data.data) === null || _b === void 0 ? void 0 : _b.bp)) {
                bidPrice = floor((_c = data.data) === null || _c === void 0 ? void 0 : _c.bp, quotePrecision);
                askPrice = floor((_d = data.data) === null || _d === void 0 ? void 0 : _d.ap, quotePrecision);
            }
        });
        wsSpot.subscribe(['outboundAccountInfo', `bookticker.${symbol}`]);
        ({ basePosition, quotePosition } = await getPositions());
        while (true) {
            var { result: { price: p }, retCode, retMsg } = await client.getLastTradedPrice(symbol);
            bidPrice = floor(p, quotePrecision);
            if (isNaN(bidPrice))
                continue;
            if (retCode == 0)
                break;
            logError(`Failed getting price (${retCode}) ${retMsg}`);
        }
        initialEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);
        while (true) {
            await asyncSleep(100);
            if (size == 0) {
                let tradableEquity = initialEquity * tradeMargin;
                targetProfit = tradableEquity * targetROI;
                size = floor((tradableEquity * leverage) / bidPrice, basePrecision);
                await reconcileLoan(basePosition, size, bidPrice);
                positionsNeedUpdate = true;
            }
            if (positionsNeedUpdate) {
                ({ basePosition, quotePosition } = await getPositions());
                positionsNeedUpdate = false;
            }
            ({ sessionEquity, strikePrice } = await executeTrade({ askPrice, basePosition, bidPrice, initialEquity, size, quotePosition, strikePrice, sessionEquity, targetProfit }));
        }
    }
    catch (err) {
        try {
            await logError(`${err}`);
            closeWebSocket(wsSpot);
        }
        catch (lerr) {
            console.error(lerr);
        }
    }
}
//# sourceMappingURL=index.js.map