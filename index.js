const { exit } = await
import('node:process');
const { WebSocket } = await
import('ws');
const { createHmac } = await
import('node:crypto');
const querystring = await
import('node:querystring');
await
import('dotenv/config');
const { setTimeout: asyncSleep } = await import('timers/promises');

const baseApiUrl = 'https://fapi.apollox.finance/fapi/v1';
const baseWssUrl = 'wss://fstream.apollox.finance/ws';
const recvWindow = 99999;
const checkInterval = 3000;

const key = process.env.PANCAKE_KEY || (() => { throw "access key required"; })();
const secret = process.env.PANCAKE_SECRET || (() => { throw "secret key required"; })();

const symbol = process.env.PANCAKE_SYMBOL || (() => { throw "symbol required"; })();
const tolerance = parseFloat(process.env.PANCAKE_TOLERANCE) || (() => { throw "tolerance needs to be a number"; })();
const takeProfit = parseFloat(process.env.PANCAKE_TAKE_PROFIT) || (() => { throw "take profit needs to be a number"; })();
const cashSize = parseFloat(process.env.PANCAKE_CASH_SIZE) || (() => { throw "cash size needs to be a number"; })();
const strikePrice = parseFloat(process.env.PANCAKE_STRIKE_PRICE) || (() => { throw "strike price needs to be a number"; })();

let executions = {};
let checkPriceRef = null;

const round1 = num => Math.round(num * 10) / 10;
const round3 = num => Math.round(num * 1000) / 1000;

async function signedFetch(action, queryObj, method) {
    queryObj = {
        "recvWindow": recvWindow,
        ...queryObj,
        "timestamp": Date.now()
    };

    method = method || 'POST';
    const query = querystring.encode(queryObj);
    const hash = createHmac('sha256', secret)
        .update(query)
        .digest('hex');
    const url = `${baseApiUrl}/${action}?${query}&signature=${hash}`;

    return await callFetch(url, method, key);
}

async function callFetch(url, method, key) {
    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                "X-MBX-APIKEY": key
            }
        });

        if (response.status != 200) {
            let msg = await response.text();
            throw `${response.status} ${msg}`;
        }

        const responseJson = await response.json();
        if (responseJson.code && responseJson.code < 0) {
            throw `${responseJson.code} ${responseJson.msg}`;
        }
        return responseJson;
    } catch (e) {
        console.error(`error fetching ${method} ${url}`);
        console.error(e);
        return null;
    }
}

async function unsignedFetch(action, queryObj, method) {
    method = method || 'POST';
    let url = `${baseApiUrl}/${action}`;
    if (queryObj) url = `${url}?${querystring.encode(queryObj)}`;
    return await callFetch(url, method, key);
}

function keygen(message) {
    if (!message || !message.e) return null;
    if (message.e == 'ORDER_TRADE_UPDATE' && message.o.o == 'LIQUIDATION') return 'LIQUIDATION';
    if (message.e == 'ORDER_TRADE_UPDATE' && message.o.x == 'EXPIRED') return `EXPIRED:${message.o.i}`;
    if (message.e == 'ORDER_TRADE_UPDATE' && message.o.X == 'FILLED') return `FILLED:${message.o.i}`;
    return null;
}

const placeClose = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "BUY",
    "type": "STOP_MARKET",
    "stopPrice": o.price,
    "closePosition": true
});

const placeShort = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "SELL",
    "type": "STOP_MARKET",
    "stopPrice": o.price,
    "quantity": o.quantity
});

const placeMarketClose = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "BUY",
    "type": "MARKET",
    "reduceOnly": true,
    "quantity": o.quantity
});

async function placeAndSetupOrder(order, placeOrder, callBack) {
    const response = await placeOrder(order);
    if (!response) return null;
    const responseId = response.orderId;

    executions[`FILLED:${responseId}`] = callBack;
    executions[`EXPIRED:${responseId}`] = createExpiredCallback(order, placeOrder, callBack);
    return response;
}

function createExpiredCallback(order, placeOrder, callback) {
    return async message => {
        console.log(`EXPIRED:${message.o.i}`);
        var orders = await signedFetch('allOrders', { symbol }, 'GET') || [];
        for (let i = 0; i < orders.length; i++) {
            let order = orders[i];
            if (order.orderId == message.o.i && order.status == 'FILLED') {
                console.log(`${message.o.i} side ${message.o.S} already filled`);
                return;
            }
        }

        delete executions[`FILLED:${message.o.i}`];
        delete executions[`EXPIRED:${message.o.i}`];

        if (message.o.S == "SELL") {
            while (!(await placeAndSetupOrder(order, placeOrder, callback))) { }
            return;
        }

        const size = round3(cashSize / message.o.sp);

        while (!(await placeMarketClose({ quantity: size }))) { }
        await callback(message);
    }
}

async function placeStrike() {
    const size = round3(cashSize / strikePrice);
    let strikeResponse
    while (!strikeResponse) {
        strikeResponse = await placeAndSetupOrder({ price: strikePrice, quantity: size }, placeShort, shortFilled);
    }

    console.log(`strike order placed price:${strikePrice} size:${size} cash-size:${cashSize}`);
    return strikeResponse;
}

async function cancelOrder(orderId) {
    await signedFetch('order', {
        "symbol": symbol,
        "orderId": orderId
    }, 'DELETE');

    delete executions[`FILLED:${orderId}`];
    delete executions[`EXPIRED:${orderId}`];
}

async function closeFilled(message) {
    const orderId = message.o.i;
    const stopPrice = message.o.sp;
    const lastPrice = message.o.L;
    const lastPriceTolerance = round1(lastPrice * (1 - tolerance));
    const stopPriceTolerance = round1(stopPrice * (1 - tolerance));
    const shortPrice = Math.max(lastPriceTolerance, stopPriceTolerance);
    const shortPriceTolerance = round1(stopPrice * (1 + tolerance));
    const strikePriceTolerance = round1(strikePrice * (1 + tolerance));
    const size = round3(cashSize / shortPrice);

    if (checkPriceRef) clearInterval(checkPriceRef);
    delete executions[`FILLED:${orderId}`];
    delete executions[`EXPIRED:${orderId}`];

    let shortResponse;
    while (!shortResponse) {
        shortResponse = await placeAndSetupOrder({ price: shortPrice, quantity: size }, placeShort, shortFilled);
    }
    let shortOrderId = shortResponse.orderId;
    console.log(`${shortOrderId} place short at ${shortPrice} size: ${size} lastPrice:${lastPrice} sp:${stopPrice} closeOrderId:${orderId}`);

    let inCallback = false;
    checkPriceRef = setInterval(async () => {
        if (inCallback) return;
        inCallback = true;

        const marketResponse = await unsignedFetch('premiumIndex', { symbol }, 'GET');
        if (!marketResponse) {
            inCallback = false;
            return;
        };

        const marketPrice = marketResponse.markPrice;
        if (marketPrice <= shortPriceTolerance && marketPrice <= strikePriceTolerance) {
            inCallback = false;
            return;
        }

        const newShortPrice = (marketPrice > strikePriceTolerance) ? strikePrice : stopPrice;
        const newSize = round3(cashSize / newShortPrice);

        let reAdjust;
        while (!reAdjust) {
            reAdjust = placeAndSetupOrder({ price: newShortPrice, quantity: newSize }, placeShort, shortFilled);
        }

        console.log(`${reAdjust.orderId} re-adjusted short to ${newShortPrice} new size ${newSize} market price: ${marketPrice} oldId:${shortOrderId}`);
        await cancelOrder(shortOrderId);
        shortOrderId = reAdjust.orderId;
        inCallback = false;

        if (marketPrice > strikePriceTolerance) clearInterval(checkPriceRef);
    }, checkInterval);

    //console.log(`${Date.now()} ${shortOrderId} Close Filled Side: ${message.o.S} Order Type:${message.o.o} Execution Type:${message.o.x} Order Status:${message.o.X} Position Side:${message.o.ps}`);
}

async function shortFilled(message) {
    const lastPrice = message.o.L;
    const stopPrice = message.o.sp;
    const lastPriceTolerance = round1(lastPrice * (1 + tolerance));
    const stopPriceTolerance = round1(stopPrice * (1 + tolerance));
    let closePrice = Math.min(lastPriceTolerance, stopPriceTolerance);
    const takeProfitPrice = round1(closePrice * (1 - takeProfit));
    const takeProfitTolerance = round1(takeProfitPrice * (1 - tolerance));

    if (checkPriceRef) clearInterval(checkPriceRef);
    delete executions[`FILLED:${message.o.i}`];
    delete executions[`EXPIRED:${message.o.i}`];

    // keep retrying on failures
    let closeResponse;
    while (!closeResponse) {
        closeResponse = await placeAndSetupOrder({ price: closePrice }, placeClose, closeFilled);
    }
    const closeOrderId = closeResponse.orderId;
    console.log(`${closeOrderId} placed close at ${closePrice} lastPrice: ${lastPrice} sp:${stopPrice} shortOrderId:${message.o.i}`);

    const accountResponse = await signedFetch('account', null, 'GET');
    while (!(await signedFetch('positionMargin', {
        "symbol": symbol,
        "amount": accountResponse.availableBalance,
        "type": 1
    }))) { };
    console.log(`repositioned margin with available balance ${accountResponse.availableBalance}`);

    let inCallback = false;
    checkPriceRef = setInterval(async () => {
        if (inCallback) return;
        inCallback = true;

        const marketResponse = await unsignedFetch('premiumIndex', { symbol }, 'GET');
        if (!marketResponse) {
            inCallback = false;
            return;
        };

        if (marketResponse.markPrice >= takeProfitTolerance) {
            inCallback = false;
            return;
        };

        const reAdjust = await placeAndSetupOrder({ price: takeProfitPrice }, placeClose, closeFilled);
        if (!reAdjust) {
            inCallback = false;
            return;
        };

        console.log(`${reAdjust.orderId} re-adjusted close at ${takeProfitPrice} market: ${marketResponse.markPrice} oldId:${closeOrderId}`);
        await cancelOrder(closeOrderId);
        clearInterval(checkPriceRef);

    }, checkInterval);

    //console.log(`${Date.now()} ${closeOrderId} Short Filled Side: ${message.o.S} Order Type:${message.o.o} Execution Type:${message.o.x} Order Status:${message.o.X} Position Side:${message.o.ps}`);
}

async function onMessage(data) {
    try {
        const dataText = data.toString('utf-8');
        const message = JSON.parse(dataText);
        const execKey = keygen(message);
        if (!execKey) return;

        const execFunc = executions[execKey];
        if (!execFunc) return;

        await execFunc(message);
    } catch (ex) {
        console.error('message error');
        console.error(ex);
    }
}

try {
    process.stdin.on('data', process.exit.bind(process, 0));
    console.log(`strike-price ${strikePrice} cash-size ${cashSize}`);

    while (true) {
        var { listenKey } = await unsignedFetch('listenKey');
        if (!listenKey) process.exit();

        var socket = new WebSocket(`${baseWssUrl}/${listenKey}`);
        socket.on('message', async data => await onMessage(data));
        console.log(`listening for events key:${listenKey}`);

        var listenRef = setInterval(async () => {
            console.log('renewing key');
            await unsignedFetch('listenKey', 'PUT');
        }, 3540000/*59 minutes: 59 minutes * 60 seconds * 1000 milliseconds*/);

        executions['LIQUIDATION'] = placeStrike;
        var orders = await signedFetch('openOrders', { symbol }, 'GET') || [];

        if (orders.length == 0) {
            await placeStrike();
        }

        for (let i = 0; i < orders.length; i++) {
            let order = orders[i];
            if (order.side == "BUY") {
                executions[`FILLED:${order.orderId}`] = closeFilled
                executions[`EXPIRED:${order.orderId}`] = createExpiredCallback({ price: order.price }, placeClose, closeFilled);
            }

            if (order.side == "SELL") {
                executions[`FILLED:${order.orderId}`] = shortFilled
                executions[`EXPIRED:${order.orderId}`] = createExpiredCallback({ price: order.price, quantity: order.origQty }, placeShort, shortFilled);
            }
        }

        await asyncSleep(86400000/*24 hours: 24 hours * 60 minutes * 60 seconds * 1000 milliseconds*/);
    }

} catch (ex) {
    console.error(ex);
}