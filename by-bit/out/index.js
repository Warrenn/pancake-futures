var _a;
import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import dotenv from "dotenv";
dotenv.config();
const interest = 0.0015, slippage = parseFloat(`${process.env.SLIPPAGE}`), symbol = 'ETHUSDT', baseCurrency = 'ETH', quoteCurrency = 'USDT', quantity = parseFloat(`${process.env.QUANTITY}`), useTestnet = !!((_a = process.env.TESTNET) === null || _a === void 0 ? void 0 : _a.localeCompare("false", 'en', { sensitivity: 'accent' })), minSizes = {
    ETH: 0.0005,
    USDT: 10
};
let strikePrice = parseFloat(`${process.env.STRIKEPRICE}`), initializeImmediately = true, setStrike = false, { strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage);
let client;
function round(num, precision = 2) {
    return +(Math.round(+(num + `e+${precision}`)) + `e-${precision}`);
}
function setStrikeBoundries(strikePrice, slippage) {
    let strikeLower = strikePrice * (1 - slippage), strikeUpper = strikePrice * (1 + slippage);
    return { strikeLower, strikeUpper };
}
async function conditionalBuy(symbol, orderQty, triggerPrice, quoteCoin = quoteCurrency) {
    orderQty = round(orderQty, 5);
    triggerPrice = round(triggerPrice, 2);
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
            await borrowIfRequired(quoteCoin, orderQty * triggerPrice, 2);
            continue;
        }
        if (orderResponse.retCode == 0) {
            let orderId = orderResponse.result.orderId;
            let { result: order, retCode, retMsg } = await client.getOrder({ orderId, orderCategory: 1 });
            if (retCode != 0) {
                logError(`conditionalBuy ${retMsg}`);
                initializeImmediately = true;
                return;
            }
            let { result: { price } } = await client.getLastTradedPrice(symbol);
            if (price > order.triggerPrice) {
                await logError(`Buy error price ${price} is greater than trigger ${order.triggerPrice}`);
                await client.cancelOrder({ orderId });
                initializeImmediately = true;
            }
            return;
        }
        await logError(orderResponse.retMsg);
        initializeImmediately = true;
        return;
    }
}
async function conditionalSell(coin, symbol, orderQty, triggerPrice) {
    orderQty = round(orderQty, 5);
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
            orderQty = round(orderQty, 5);
            if (orderQty > 0)
                continue;
            initializeImmediately = true;
            return;
        }
        if (orderResponse.retCode == 0) {
            let orderId = orderResponse.result.orderId;
            let { result: order, retCode, retMsg } = await client.getOrder({ orderId, orderCategory: 1 });
            if (retCode != 0) {
                await logError(`conditionalSell ${retMsg}`);
                initializeImmediately = true;
                return;
            }
            let { result: { price } } = await client.getLastTradedPrice(symbol);
            if (price < order.triggerPrice) {
                await logError(`Sell error price ${price} is less than trigger ${order.triggerPrice} `);
                await client.cancelOrder({ orderId });
                initializeImmediately = true;
            }
            return;
        }
        await logError(orderResponse.retMsg);
        initializeImmediately = true;
        return;
    }
}
async function immediateSell(symbol, orderQty, coin = baseCurrency) {
    orderQty = round(orderQty, 5);
    initializeImmediately = true;
    while (true) {
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        price = round(price, 2);
        log(`immediate sell qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
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
    initializeImmediately = true;
    ;
    while (true) {
        let { result: { price } } = await client.getLastTradedPrice(symbol);
        price = round(price, 2);
        log(`immediate buy qty: ${orderQty} at ${price}`);
        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
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
        initializeImmediately = true;
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
        initializeImmediately = true;
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
    initializeImmediately = true;
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
    position.free = round(position.free, 5);
    position.loan = round(position.loan, 5);
    let borrowing = position.loan >= quantity;
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    log(`borrowing: ${borrowing} holding: ${position.free} onloan: ${position.loan} price: ${price} strike: ${strikePrice} upper: ${strikeUpper} lower: ${strikeLower}`);
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
        position = loanAccountList.find(loanItem => loanItem.tokenId == baseCurrency) || { free: 0, loan: 0 };
        position.free = round(position.free, 5);
        position.loan = round(position.loan, 5);
    }
    if ((price > strikeUpper) && (position.free < quantity)) {
        let buyAmount = round((quantity - position.free), 5);
        await immediateBuy(symbol, buyAmount);
    }
    if ((price < strikeLower) && (position.free > 0)) {
        await immediateSell(symbol, position.free);
    }
    if ((price > strikeUpper) && (position.free > 0)) {
        strikePrice = price;
        ({ strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage));
    }
    if ((price < strikeLower) && (position.free < quantity)) {
        strikePrice = price;
        ({ strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage));
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
        const wsClient = new WebsocketClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            market: 'spotv3',
            fetchTimeOffsetBeforeAuth: true
        });
        wsClient.on('update', message => {
            var _a;
            console.log(`update: ${message === null || message === void 0 ? void 0 : message.topic}`);
            if ((message === null || message === void 0 ? void 0 : message.topic) != 'ticketInfo' || !((_a = message === null || message === void 0 ? void 0 : message.data) === null || _a === void 0 ? void 0 : _a.length))
                return;
            console.log(`snapshot: ${JSON.stringify(message, null, 2)}`);
            const data = message.data[0];
            strikePrice = +data.p;
            ({ strikeLower, strikeUpper } = setStrikeBoundries(strikePrice, slippage));
        });
        wsClient.subscribe(['ticketInfo'], true);
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 1, side: "Sell" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Buy" });
        await client.cancelOrderBatch({ symbol, orderTypes: ["LIMIT", "MARKET"], orderCategory: 0, side: "Sell" });
        while (true) {
            if (initializeImmediately) {
                await InitializePosition();
                continue;
            }
            await asyncSleep(100);
            await InitializePosition();
        }
    }
    catch (err) {
        await logError(`${err}`);
    }
}
//# sourceMappingURL=index.js.map