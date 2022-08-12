const { exit } = await
import ('node:process');
const { WebSocket } = await
import ('ws');
const { createHmac } = await
import ('node:crypto');
const querystring = await
import ('node:querystring');
await
import ('dotenv/config');

const baseApiUrl = 'https://fapi.apollox.finance/fapi/v1';
const baseWssUrl = 'wss://fstream.apollox.finance/ws';

const key = process.env.PANCAKE_KEY || (() => { throw "access key required"; })();
const secret = process.env.PANCAKE_SECRET || (() => { throw "secret key required"; })();

let executions = {};

async function signedPost(action, queryObj) {
    queryObj = {
        "recvWindow": 99999,
        ...queryObj,
        "timestamp": Date.now()
    };

    const query = querystring.encode(queryObj);
    const hash = createHmac('sha256', secret)
        .update(query)
        .digest('hex');

    const response = await fetch(`${baseApiUrl}/${action}?${query}&signature=${hash}`, {
        method: 'POST',
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
    if (message.e == 'ORDER_TRADE_UPDATE') return `${message.e}:${message.o.i}:${message.o.X}`;
    return null;
}

const symbol = process.env.PANCAKE_SYMBOL || (() => { throw "symbol required"; })();
const strikePrice = parseFloat(process.env.PANCAKE_STRIKE_PRICE) || (() => { throw "strike price needs to be a number"; })();
const closePercent = parseFloat(process.env.PANCAKE_CLOSE_PERCENT) || (() => { throw "close percent needs to be a number"; })();

const closePrice = strikePrice * (1 + closePercent);

async function closeFilled(message) {
    const shortResponse = await signedPost('order', {

    });

    executions[""] = shortFilled;
    return { removeKey: true };
}

async function shortFilled(message) {
    const shortResponse = await signedPost('order', {

    });

    executions[""] = shortFilled;


    return { removeKey: true };
}

try {
    var { listenKey } = await callFetch('listenKey');

    var interval = setInterval(async() => {
        await callFetch('listenKey', 'PUT');
    }, 59 * 60 * 1000 /*59 minutes: minutes * seconds * milliseconds*/ );

    var socket = new WebSocket(`${baseWssUrl}/${listenKey}`);

    socket.on('message', data => {
        (async() => {
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
        })();
    });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
    clearInterval(interval);
} catch (ex) {
    console.error(ex);
}