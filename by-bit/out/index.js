var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, AccountAssetClient, USDCOptionClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import dotenv from "dotenv";
dotenv.config();
const slippage = parseFloat(`${process.env.SLIPPAGE}`), margin = parseFloat(`${process.env.MARGIN}`), symbol = `${process.env.BASE}${process.env.QUOTE}`, baseCurrency = `${process.env.BASE}`, quoteCurrency = `${process.env.QUOTE}`, quantity = parseFloat(`${process.env.QUANTITY}`), quotePrecision = parseInt(`${process.env.QUOTEPRECISION}`), basePrecision = parseInt(`${process.env.BASEPRECISION}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), minSizes = {
    ETH: 0.08,
    NEAR: 1,
    USDT: 10
};
let strikePrice = parseFloat(`${process.env.STRIKEPRICE}`), retryTimeout = 5000, { strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, margin);
let client, assetClient, optionsClient;
function round(num, precision = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}
function setStrikeBoundries(strikePrice, slippage) {
    let strikeLower = strikePrice * (1 - slippage), strikeUpper = strikePrice * (1 + slippage);
    return { strikeLower, strikeUpper };
}
async function conditionalBuy(symbol, orderQty, triggerPrice, quoteCoin = quoteCurrency) {
    orderQty = round(orderQty, basePrecision);
    triggerPrice = round(triggerPrice, quotePrecision);
    while (true) {
        log(`conditional buy qty: ${orderQty} trigger ${triggerPrice}`);
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
            await logError(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * triggerPrice, quotePrecision);
            continue;
        }
        if (orderResponse.retCode == 0) {
            let orderId = orderResponse.result.orderId;
            let { result: order, retCode, retMsg } = await client.getOrder({ orderId, orderCategory: 1 });
            if (retCode != 0) {
                logError(`conditionalBuy ${retMsg}`);
                return;
            }
            let { result: { price } } = await client.getLastTradedPrice(symbol);
            if (price > order.triggerPrice) {
                await logError(`Buy error price ${price} is greater than trigger ${order.triggerPrice}`);
                await client.cancelOrder({ orderId });
            }
            return;
        }
        await logError(orderResponse.retMsg);
        return;
    }
}
async function conditionalSell(coin, symbol, orderQty, triggerPrice) {
    orderQty = round(orderQty, basePrecision);
    triggerPrice = round(triggerPrice, 2);
    while (true) {
        log(`conditional sell qty: ${orderQty} trigger ${triggerPrice} `);
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
            await logError(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = round(orderQty, basePrecision);
            if (orderQty > 0)
                continue;
            return;
        }
        if (orderResponse.retCode == 0) {
            let orderId = orderResponse.result.orderId;
            let { result: order, retCode, retMsg } = await client.getOrder({ orderId, orderCategory: 1 });
            if (retCode != 0) {
                await logError(`conditionalSell ${retMsg}`);
                return;
            }
            let { result: { price } } = await client.getLastTradedPrice(symbol);
            if (price < order.triggerPrice) {
                await logError(`Sell error price ${price} is less than trigger ${order.triggerPrice} `);
                await client.cancelOrder({ orderId });
            }
            return;
        }
        await logError(orderResponse.retMsg);
        return;
    }
}
async function immediateSell(symbol, orderQty, price, coin = baseCurrency) {
    orderQty = round(orderQty, basePrecision);
    while (true) {
        price = round(price, quotePrecision);
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
            orderQty = round(orderQty, basePrecision);
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
    orderQty = round(orderQty, basePrecision);
    while (true) {
        price = round(price, quotePrecision);
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
    let diff = round(quantity - position.free, precision);
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
async function InitializePosition() {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0 };
    position.free = round(position.free, basePrecision);
    position.loan = round(position.loan, basePrecision);
    let borrowing = position.loan >= quantity;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    log(`holding:${position.free} onloan:${position.loan} price:${price} strike:${strikePrice} upper:${strikeUpper} lower:${strikeLower}`);
    if (!borrowing) {
        let borrowAmount = round(quantity - position.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        ({ result: { loanAccountList } } = await client.getCrossMarginAccountInfo());
        position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0 };
        position.free = round(position.free, basePrecision);
        position.loan = round(position.loan, basePrecision);
    }
    let longAmount = quantity - (position.free - position.loan);
    if ((price > strikePrice) && (longAmount > 0)) {
        let buyAmount = round(longAmount, basePrecision);
        let buyPrice = round(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        return;
    }
    if ((price < strikePrice) && (position.free > 0)) {
        let sellAmount = round(position.free, basePrecision);
        let sellPrice = round(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        return;
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
        assetClient = new AccountAssetClient({
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
        let oo = await optionsClient.getSymbolTicker('ETH-24NOV22-1150-P');
        process.exit(-1);
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Sell" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Sell" });
        retryTimeout = 5000;
        while (true) {
            //await asyncSleep(200);
            await InitializePosition();
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