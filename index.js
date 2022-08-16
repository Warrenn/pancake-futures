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
const takeProfit = parseFloat(process.env.PANCAKE_TAKE_PROFIT_PERCENT) || (() => { throw "take profit needs to be a number"; })();

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
        console.error(`error fetching ${url}`);
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

async function placeAndSetupOrder(order, placeOrder, callBack) {
    const response = await placeOrder(order);
    if (!response) return null;
    const responseId = response.orderId;

    executions[`FILLED:${responseId}`] = callBack;
    executions[`EXPIRED:${responseId}`] = createExpiredCallback(order, placeOrder);
    return response;
}

async function createExpiredCallback(order, placeOrder) {
    return async message => {
        delete executions[`FILLED:${message.o.i}`];
        delete executions[`EXPIRED:${message.o.i}`];

        placeAndSetupOrder(order, placeOrder, shortFilled);
    }
}

async function placeStrike() {
    const size = cashSize / strikePrice;
    const strikeResponse = await placeAndSetupOrder({ price: strikePrice, quantity: size }, placeShort, shortFilled);

    console.log(`strike placed price:${strikePrice} size:${size}`);
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
    const lastPrice = message.o.L;
    const shortPrice = lastPrice * (1 - closePercent);
    const size = cashSize / shortPrice;

    if (checkPriceRef) clearInterval(checkPriceRef);
    delete executions[`FILLED:${message.o.i}`];
    delete executions[`EXPIRED:${message.o.i}`];

    const orderDetails = { price: shortPrice, quantity: size };
    const shortResponse = await placeAndSetupOrder(orderDetails, placeShort, shortFilled);
    if (!shortResponse) return;
    const shortOrderId = shortResponse.orderId;

    checkPriceRef = setInterval(async () => {
        const marketResponse = await unsignedFetch('premiumIndex', { symbol }, 'GET');
        if (!marketResponse) return;

        const marketPrice = marketResponse.markPrice;
        if (marketPrice < strikePrice) return;

        await placeStrike();
        await cancelOrder(shortOrderId);
        clearInterval(checkPriceRef);

    }, checkInterval);

    console.log(`${Date.now()} ${shortOrderId} Close Filled Side: ${message.o.S} Order Type:${message.o.o} Execution Type:${message.o.x} Order Status:${message.o.X} Position Side:${message.o.ps}`);
}

async function shortFilled(message) {
    const lastPrice = message.o.L;
    const closePrice = lastPrice * (1 + closePercent);
    const takeProfitPrice = lastPrice * (1 - takeProfit);

    if (checkPriceRef) clearInterval(checkPriceRef);
    delete executions[`FILLED:${message.o.i}`];
    delete executions[`EXPIRED:${message.o.i}`];

    const closeResponse = await placeAndSetupOrder({ price: closePrice }, placeClose, closeFilled);
    if (!closeResponse) return;
    const closeOrderId = closeResponse.orderId;

    checkPriceRef = setInterval(async () => {
        const marketResponse = await unsignedFetch('premiumIndex', { symbol }, 'GET');
        if (!marketResponse) return;

        const marketPrice = marketResponse.markPrice;
        if (marketPrice > takeProfitPrice) return;

        await placeAndSetupOrder({ price: takeProfitPrice }, placeClose, closeFilled);
        await cancelOrder(shortOrderId);
        clearInterval(checkPriceRef);

    }, checkInterval);

    console.log(`${Date.now()} ${closeOrderId} Short Filled Side: ${message.o.S} Order Type:${message.o.o} Execution Type:${message.o.x} Order Status:${message.o.X} Position Side:${message.o.ps}`);
}

async function onMessage(data) {
    try {
        const dataText = data.toString('utf-8');
        console.log(dataText);
        const message = JSON.parse(dataText);
        console.log(message.e);
        const execKey = keygen(message);
        if (!execKey) return;

        const execFunc = executions[execKey];
        if (!execFunc) return;

        const result = await execFunc(message);
        if (result.removeKey) delete executions[execKey];
    } catch (ex) {
        console.error('message error');
        console.error(ex);
    }
}

//place logic when liquidation occurs
//figure out expiration and renewal

try {
    console.log(`strike-price ${strikePrice} close-price ${closePrice}`);
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