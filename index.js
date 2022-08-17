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
const closePercent = parseFloat(process.env.PANCAKE_CLOSE_PERCENT) || (() => { throw "close percent needs to be a number"; })();
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
    //if (message.e == 'ORDER_TRADE_UPDATE' && message.o.x == 'EXPIRED') return `EXPIRED:${message.o.i}`;
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

async function placeAndSetupOrder(order, placeOrder, callBack) {
    const response = await placeOrder(order);
    if (!response) return null;
    const responseId = response.orderId;

    executions[`FILLED:${responseId}`] = callBack;
    //executions[`EXPIRED:${responseId}`] = createExpiredCallback(order, placeOrder);
    return response;
}

function createExpiredCallback(order, placeOrder) {
    return async message => {
        delete executions[`FILLED:${message.o.i}`];
        //delete executions[`EXPIRED:${message.o.i}`];

        placeAndSetupOrder(order, placeOrder, shortFilled);
    }
}

async function placeStrike() {
    const size = round3(cashSize / strikePrice);
    const strikeResponse = await placeAndSetupOrder({ price: strikePrice, quantity: size }, placeShort, shortFilled);
    return strikeResponse;
}

async function cancelOrder(orderId) {
    await signedFetch('order', {
        "symbol": symbol,
        "orderId": orderId
    }, 'DELETE');

    delete executions[`FILLED:${orderId}`];
    //delete executions[`EXPIRED:${orderId}`];
}

async function closeFilled(message) {
    const lastPrice = message.o.L;
    let shortPrice = round1(lastPrice * (1 - closePercent));
    shortPrice = Math.min(shortPrice, strikePrice);
    const size = round3(cashSize / shortPrice);

    if (checkPriceRef) clearInterval(checkPriceRef);
    delete executions[`FILLED:${message.o.i}`];
    //delete executions[`EXPIRED:${message.o.i}`];

    const orderDetails = { price: shortPrice, quantity: size };
    let shortResponse = null;
    while (!shortResponse) {
        shortResponse = await placeAndSetupOrder(orderDetails, placeShort, shortFilled);
    }
    console.log(`place short at ${shortPrice} size: ${size} lastPrice:${lastPrice} sp:${message.o.sp}`);

    if (shortPrice == strikePrice) return;
    const shortOrderId = shortResponse.orderId;

    const strikeCheck = strikePrice * (1 + closePercent);
    let inCallback = false;
    checkPriceRef = setInterval(async () => {
        if (inCallback) return;
        inCallback = true;

        const marketResponse = await unsignedFetch('premiumIndex', { symbol }, 'GET');
        if (!marketResponse) {
            inCallback = false;
            return;
        };

        const marketPrice = round1(marketResponse.markPrice);
        if (marketPrice <= strikeCheck) {
            inCallback = false;
            return;
        };

        const reAdjust = await placeStrike();
        if (!reAdjust) {
            inCallback = false;
            return;
        };

        clearInterval(checkPriceRef);
        console.log(`re-adjusted to strike at ${marketPrice} strike: ${strikePrice}`);
        await cancelOrder(shortOrderId);

    }, checkInterval);

    //console.log(`${Date.now()} ${shortOrderId} Close Filled Side: ${message.o.S} Order Type:${message.o.o} Execution Type:${message.o.x} Order Status:${message.o.X} Position Side:${message.o.ps}`);
}

async function shortFilled(message) {
    const lastPrice = message.o.L;
    let closePrice = round1(lastPrice * (1 + closePercent));

    if (lastPrice < message.o.sp) closePrice = Math.min(closePrice, message.o.sp);

    if (checkPriceRef) clearInterval(checkPriceRef);
    delete executions[`FILLED:${message.o.i}`];
    //delete executions[`EXPIRED:${message.o.i}`];

    // keep retrying on failures
    let closeResponse = null;
    while (!closeResponse) {
        closeResponse = await placeAndSetupOrder({ price: closePrice }, placeClose, closeFilled);
    }
    console.log(`placed close at ${closePrice} lastPrice: ${lastPrice} sp:${message.o.sp}`);

    if (closePrice < strikePrice) return;
    const closeOrderId = closeResponse.orderId;

    const strikeCheck = strikePrice * (1 - closePercent);
    let inCallback = false;
    checkPriceRef = setInterval(async () => {
        if (inCallback) return;
        inCallback = true;

        const marketResponse = await unsignedFetch('premiumIndex', { symbol }, 'GET');
        if (!marketResponse)  {
            inCallback = false;
            return;
        };

        const marketPrice = round1(marketResponse.markPrice);
        if (marketPrice >= strikeCheck)  {
            inCallback = false;
            return;
        };

        const reAdjust = await placeAndSetupOrder({ price: strikePrice }, placeClose, closeFilled);
        if (!reAdjust)  {
            inCallback = false;
            return;
        };

        clearInterval(checkPriceRef);
        console.log(`re-adjusted close at ${strikePrice} market: ${marketPrice}`);
        await cancelOrder(closeOrderId);

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
    console.log(`strike-price ${strikePrice}`);
    var { listenKey } = await unsignedFetch('listenKey');
    if (!listenKey) process.exit();

    var socket = new WebSocket(`${baseWssUrl}/${listenKey}`);
    socket.on('message', async data => await onMessage(data));

    var listenRef = setInterval(async () => {
        console.log('renewing key');
        await unsignedFetch('listenKey', 'PUT');
    }, 3540000/*59 minutes: 59 minutes * 60 seconds * 1000 milliseconds*/);

    await placeStrike();
    executions['LIQUIDATION'] = placeStrike;

    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
} catch (ex) {
    console.error(ex);
}