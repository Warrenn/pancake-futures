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
const closePercent = parseFloat(process.env.PANCAKE_CLOSE_PERCENT) || (() => { throw "close percent needs to be a number"; })();

const cashSize = parseFloat(process.env.PANCAKE_CASH_SIZE) || (() => { throw "cash size needs to be a number"; })();
const strikePrice = parseFloat(process.env.PANCAKE_STRIKE_PRICE) || (() => { throw "strike price needs to be a number"; })();

let executions = {};

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

    try {
        const response = await fetch(`${baseApiUrl}/${action}?${query}&signature=${hash}`, {
            method: method,
            headers: {
                "X-MBX-APIKEY": key
            }
        });
        const responseJson = await response.json();
        return responseJson;
    } catch (e) {
        console.error(`signedFetch error ${baseApiUrl}/${action}?${query}&signature=${hash}`);
        console.error(e);
        return null;
    }
}

async function callFetch(action, queryObj, method) {
    method = method || 'POST';
    let query = '';
    if (queryObj) query = `?${querystring.encode(queryObj)}`;
    try {
        const response = await fetch(`${baseApiUrl}/${action}${query}`, {
            method: method,
            headers: {
                "X-MBX-APIKEY": key
            }
        });
        const responseJson = await response.json();
        return responseJson;
    }
    catch (e) {
        console.error(`callFetch error ${baseApiUrl}/${action}${query}`);
        console.error(e);
        return null;
    }
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
    "stopPrice": o.price,
    "price": o.price,
    "reduceOnly": true,
    "quantity": o.quantity
});

const placeShort = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "SELL",
    "type": "STOP",
    "stopPrice": o.price,
    "price": o.price,
    "quantity": o.quantity
});


const round1 = num => Math.round(num * 10) / 10;
const round3 = num => Math.round(num * 1000) / 1000;

const size = round3(cashSize / strikePrice);
const closePrice = round1(strikePrice * (1 + closePercent));

async function closeFilled(message) {
    const shortResponse = await placeShort({ price: strikePrice, quantity: size });
    if (!shortResponse) return;
    executions[`ORDER_TRADE_UPDATE:${shortResponse.orderId}:FILLED`] = shortFilled;

    console.log(`closed at ${message.o.L}`);
    return { removeKey: true };
}

async function shortFilled(message) {
    const closeResponse = await placeClose({ price: closePrice, quantity: size });
    if (!closeResponse) return;
    executions[`ORDER_TRADE_UPDATE:${closeResponse.orderId}:FILLED`] = closeFilled;

    console.log(`shorted at ${message.o.L}`);
    return { removeKey: true };
}

async function onMessage(data) {
    try {
        const dataText = data.toString('utf-8');
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

try {
    console.log(`strike-price ${strikePrice} close-price ${closePrice}`);
    var { listenKey } = await callFetch('listenKey');
    if (!listenKey) process.exit();

    var socket = new WebSocket(`${baseWssUrl}/${listenKey}`);
    socket.on('message', async data => await onMessage(data));

    var listenRef = setInterval(async () => {
        console.log('renewing key');
        var putResponse = await callFetch('listenKey', 'PUT');
        if (putResponse) return;

        console.error(`key:${listenKey} not found`);
        if (socket && socket.OPEN) socket.close();
        await callFetch('listenKey', 'DELETE');
        
        while (true) {
            let listResponse = await callFetch('listenKey');
            if (!listResponse || !listResponse.listenKey) continue;
            listenKey = listResponse.listenKey;
            break;
        }
        
        socket = new WebSocket(`${baseWssUrl}/${listenKey}`);
        socket.on('message', async data => await onMessage(data));

    }, 30000/*59 minutes: 59 minutes * 60 seconds * 1000 milliseconds*/);

    await closeFilled({ o: { L: strikePrice } });

    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
} catch (ex) {
    console.error(ex);
}