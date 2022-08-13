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

const key = process.env.PANCAKE_KEY || (() => { throw "access key required"; })();
const secret = process.env.PANCAKE_SECRET || (() => { throw "secret key required"; })();

const symbol = process.env.PANCAKE_SYMBOL || (() => { throw "symbol required"; })();
const strikePrice = parseFloat(process.env.PANCAKE_STRIKE_PRICE) || (() => { throw "strike price needs to be a number"; })();
const closePercent = parseFloat(process.env.PANCAKE_CLOSE_PERCENT) || (() => { throw "close percent needs to be a number"; })();
const cashSize = parseFloat(process.env.PANCAKE_CASH_SIZE) || (() => { throw "cash size needs to be a number"; })();
const sleepInterval = parseInt(process.env.PANCAKE_SLEEP) || 3000;

let executions = {};
let intervalRef = null;

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

    const response = await fetch(`${baseApiUrl}/${action}?${query}&signature=${hash}`, {
        method: method,
        headers: {
            "X-MBX-APIKEY": key
        }
    });
    const responseJson = await response.json();
    return responseJson;
}

async function callFetch(action, method) {
    method = method || 'POST';
    const response = await fetch(`${baseApiUrl}/${action}`, {
        method: method,
        headers: {
            "X-MBX-APIKEY": key
        }
    });
    const responseJson = await response.json();
    return responseJson;
}

function keygen(message) {
    if (!message || !message.e) return null;
    if (message.e == 'ORDER_TRADE_UPDATE') return `ORDER_TRADE_UPDATE:${message.o.i}:${message.o.X}`;
    return null;
}

const placeClose = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "BUY",
    "type": "STOP",
    "price": o.price,
    "stopPrice": o.price,
    "closePosition": true
});

const placeShort = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "SELL",
    "type": "STOP",
    "price": o.price,
    "stopPrice": o.price,
    "size": o.size
});

async function closeFilled(message) {
    const lastPrice = parseFloat(message.o.L);
    const price = lastPrice * (1 - closePercent);
    const size = cashSize / price;

    if (intervalRef) {
        clearInterval(intervalRef);
        intervalRef = null;
    }

    const orderResponse = await placeShort({ price, size });
    const callbackKey = `ORDER_TRADE_UPDATE:${orderResponse.orderId}:FILLED`;

    executions[callbackKey] = shortFilled;

    intervalRef = setInterval(async () => {
        const marketResp = await callFetch('premiumIndex', 'GET');
        if (marketResp.markPrice < strikePrice) return;
        const strikeSize = cashSize / strikePrice;

        await signedFetch('allOpenOrders', { symbol }, 'DELETE');
        const strikeResponse = await placeShort({ price: strikePrice, size: strikeSize });

        delete executions[callbackKey];
        executions[`ORDER_TRADE_UPDATE:${strikeResponse.orderId}:FILLED`] = shortFilled;

        clearInterval(intervalRef);
    }, sleepInterval);

    return { removeKey: true };
}

async function shortFilled(message) {
    const lastPrice = parseFloat(message.o.L);
    const price = lastPrice * (1 + closePercent);

    if (intervalRef) {
        clearInterval(intervalRef);
        intervalRef = null;
    }

    const orderResponse = await placeClose({ price });
    const callbackKey = `ORDER_TRADE_UPDATE:${orderResponse.orderId}:FILLED`;

    executions[callbackKey] = closeFilled;

    intervalRef = setInterval(async () => {
        const marketResp = await callFetch('premiumIndex', 'GET');
        if (marketResp.markPrice > strikePrice) return;

        await signedFetch('allOpenOrders', { symbol }, 'DELETE');
        const strikeResponse = await placeClose({ price: strikePrice });

        delete executions[callbackKey];
        executions[`ORDER_TRADE_UPDATE:${strikeResponse.orderId}:FILLED`] = closeFilled;
        clearInterval(intervalRef);

    }, sleepInterval);

    return { removeKey: true };
}

try {
    var { listenKey } = await callFetch('listenKey');

    var interval = setInterval(async () => {
        await callFetch('listenKey', 'PUT');
    }, 59 * 60 * 1000 /*59 minutes: minutes * seconds * milliseconds*/);

    var socket = new WebSocket(`${baseWssUrl}/${listenKey}`);

    socket.on('message', async data => {
        try {
            const message = JSON.parse(data.toString('utf-8'));
            const execKey = keygen(message);
            if (!execKey) return;

            const execFunc = executions[execKey];
            if (!execFunc) return;

            const result = await execFunc(message);
            if (result.removeKey) delete executions[execKey];
        } catch (ex) {
            console.error(ex);
        }
    });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
    clearInterval(interval);
} catch (ex) {
    console.error(ex);
}