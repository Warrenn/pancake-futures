const { exit } = await import('node:process');
const { WebSocket } = await import('ws');
const { createHmac } = await import('node:crypto');
const querystring = await import('node:querystring');
await import('dotenv/config');

const baseApiUrl = 'https://fapi.apollox.finance/fapi/v1';
const baseWssUrl = 'wss://fstream.apollox.finance/ws';

const key = process.env.PANCAKE_KEY;
const secret = process.env.PANCAKE_SECRET;

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


try {
    var { listenKey } = await callFetch('listenKey');

    var interval = setInterval(async () => {
        await callFetch('listenKey', 'PUT');
    }, 59 * 60 * 1000/*59 minutes: minutes * seconds * milliseconds*/);

    var socket = new WebSocket(`${baseWssUrl}/${listenKey}`);

    socket.on('message', function message(data) {
        var message = JSON.parse(data.toString('utf-8'));
        if (message.e !== 'ORDER_TRADE_UPDATE') return;
        //if the initial placement
        //put a trailing stop
    });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
    clearInterval(interval);
}
catch (ex) {
    console.error(ex);
}