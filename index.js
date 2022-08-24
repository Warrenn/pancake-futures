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
let shortSize;

const round1 = num => Math.round(num * 10) / 10;
const round3 = num => Math.round(num * 1000) / 1000;

const size = round3(cashSize / strikePrice);

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


const placeMarketShort = async (o) => await signedFetch('order', {
    "symbol": symbol,
    "side": "SELL",
    "type": "MARKET",
    "quantity": o.quantity
});

async function placeAndSetupOrder(order, placeOrder, callBack) {
    await signedFetch('allOpenOrders', { symbol }, "DELETE");

    const response = await placeOrder(order);
    if (!response) return null;
    const responseId = response.orderId;

    executions[`FILLED:${responseId}`] = callBack;
    executions[`EXPIRED:${responseId}`] = expiredCallback;
    return response;
}

function expiredCallback(message) {
    const expiredOrderId = message.o.i;
    console.log(`EXPIRED:${expiredOrderId}`);
    var orders = await signedFetch('allOrders', { symbol }, 'GET') || [];
    for (let i = 0; i < orders.length; i++) {
        let order = orders[i];
        if (order.orderId == expiredOrderId && order.status == 'FILLED') {
            console.log(`${expiredOrderId} side ${message.o.S} already filled`);
            return;
        }
    }

    delete executions[`FILLED:${expiredOrderId}`];
    delete executions[`EXPIRED:${expiredOrderId}`];

    console.log(`${expiredOrderId} Expired re initializing`);
    await initialize();
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

    delete executions[`FILLED:${orderId}`];
    delete executions[`EXPIRED:${orderId}`];

    let shortResponse;
    while (true) {
        shortResponse = await placeAndSetupOrder({ price: strikePrice, quantity: size }, placeShort, shortFilled);
        if (shortResponse && shortResponse.orderId) break;
    }
    let shortOrderId = shortResponse.orderId;
    console.log(`${shortOrderId} place short at ${strikePrice} size: ${size} lastPrice:${lastPrice} sp:${stopPrice} closeOrderId:${orderId}`);

    //console.log(`${Date.now()} ${shortOrderId} Close Filled Side: ${message.o.S} Order Type:${message.o.o} Execution Type:${message.o.x} Order Status:${message.o.X} Position Side:${message.o.ps}`);
}

async function shortFilled(message) {
    const lastPrice = message.o.L;
    const stopPrice = message.o.sp;
    const orderId = message.o.i;
    const price = round1(strikePrice * (1 + tolerance));

    delete executions[`FILLED:${orderId}`];
    delete executions[`EXPIRED:${orderId}`];

    // keep retrying on failures
    let closeResponse;
    while (!closeResponse) {
        closeResponse = await placeAndSetupOrder({ price }, placeClose, closeFilled);
    }
    const closeOrderId = closeResponse.orderId;
    console.log(`${closeOrderId} placed close at ${price} lastPrice: ${lastPrice} sp:${stopPrice} shortOrderId:${orderId}`);

    const accountResponse = await signedFetch('account', null, 'GET');
    while (!(await signedFetch('positionMargin', {
        "symbol": symbol,
        "amount": accountResponse.availableBalance,
        "type": 1
    }))) { };
    console.log(`${closeOrderId} repositioned margin with available balance ${accountResponse.availableBalance} shortOrderId:${orderId}`);

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

async function initialize() {
    const openOrdersPromise = signedFetch('openOrders', { symbol }, 'GET');
    const premiumIndexPromise = unsignedFetch('premiumIndex', { symbol }, 'GET');
    const positionRiskPromise = signedFetch('positionRisk', { symbol }, 'GET');

    const results = await Promise.all([openOrdersPromise, premiumIndexPromise, positionRiskPromise]);
    const orders = results[0] || [];
    let haveShortOrder = false;
    let haveCloseOrder = false;
    const currentPrice = results[1].markPrice;
    const holdingPosition = results[2] && results[2].length && parseFloat(results[2][0].positionAmt) > 0;
    const positionSize = (holdingPosition) ? results[2][0].positionAmt : 0;

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        const orderId = order.orderId;
        if (order.side == "SELL") {
            haveShortOrder = true;
            executions[`FILLED:${orderId}`] = shortFilled;
            executions[`EXPIRED:${orderId}`] = expiredCallback;
        }
        if (order.side == "BUY" && (order.reduceOnly || order.closePosition) {
            haveCloseOrder = true;
            executions[`FILLED:${orderId}`] = closeFilled;
            executions[`EXPIRED:${orderId}`] = expiredCallback;
        }
    }

    if (currentPrice > strikePrice && holdingPosition) {
        await signedFetch('allOpenOrders', { symbol }, 'DELETE');
        await placeMarketClose({ quantity: positionSize });
        await placeStrike();
        return;
    }

    if (currentPrice > strikePrice && !holdingPosition && !haveShortOrder) {
        await signedFetch('allOpenOrders', { symbol }, 'DELETE');
        await placeStrike();
        return;
    }

    if (currentPrice <= strikePrice && holdingPosition && !haveCloseOrder) {
        await signedFetch('allOpenOrders', { symbol }, 'DELETE');
        await shortFilled({ o: { sp: currentPrice, L: currentPrice } });
        return;
    }

    if (currentPrice <= strikePrice && !holdingPosition) {
        await signedFetch('allOpenOrders', { symbol }, 'DELETE');
        const quantity = round3(cashSize / currentPrice);
        await placeMarketShort({ quantity });
        await shortFilled({ o: { sp: currentPrice, L: currentPrice } });
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
        await initialize();

        await asyncSleep(86400000/*24 hours: 24 hours * 60 minutes * 60 seconds * 1000 milliseconds*/);
    }

} catch (ex) {
    console.error(ex);
}