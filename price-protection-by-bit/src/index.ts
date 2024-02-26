import { setTimeout as asyncSleep } from 'timers/promises';
import { RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';

type State = {
    bid: number
    ask: number
    position: number
    orderId: string
    entryPrice: number
    breakEvenPrice: number
    orderPrice: number
    threshold: number
}

type Credentials = {
    apiKey: string
    apiSecret: string
}

type Settings = {
    strikePrice: number
    thresholdPercent: number
    direction: 'long' | 'short'
    slPercent: number
    symbol: string
    size: number
}

type Context = {
    state: State
    settings: Settings
    restClient: RestClientV5
    process: (context: Context) => Promise<void>
}

function orderbookUpdate(data: any, state: State) {
    if (!data || !data.data || !data.data.b || !data.data.a) return;
    if (data.data.b.length > 0 && data.data.b[0].length > 0) state.bid = data.data.b[0][0];
    if (data.data.a.length > 0 && data.data.a[0].length > 0) state.ask = data.data.a[0][0];
}

function websocketCallback(state: State): (response: any) => void {
    return (data) => {
        if (!data.topic) return;
        let topic = data.topic.split('.');
        if (topic.length < 0) return;
        switch (topic[0]) {
            case 'orderbook':
                orderbookUpdate(data, state);
                break;
        }
    }
}

async function getCredentials({ ssm, name, apiCredentialsKeyPrefix }: { ssm: SSMClient, name: string, apiCredentialsKeyPrefix: string }): Promise<Credentials> {
    let getCommand = new GetParameterCommand({ Name: `${apiCredentialsKeyPrefix}${name}`, WithDecryption: true })
    let ssmParam = await ssm.send(getCommand);
    return JSON.parse(`${ssmParam.Parameter?.Value}`);
}

async function getSettings({ ssm, name, keyPrefix }: { ssm: SSMClient, name: string, keyPrefix: string }): Promise<Settings> {
    let getCommand = new GetParameterCommand({ Name: `${keyPrefix}${name}` })
    let ssmParam = await ssm.send(getCommand);
    return JSON.parse(`${ssmParam.Parameter?.Value}`);
}

//OTM long state
async function longOTM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, entryPrice: executedPrice, breakEvenPrice, orderPrice, threshold } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    if (!havePosition && ask >= strikePrice && orderId) {
        state.orderPrice = ask;
        //create order
        let price = `${round(bid, 2)}`;
        let qty = `${round(context.settings.size, 3)}`;

        //create buy order
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price,
            qty
        });
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && ask >= strikePrice && ask !== orderPrice && orderId) {
        state.orderPrice = ask;
        let price = `${round(bid, 2)}`;
        //update order
        let { result: order } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price
        });
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && ask < strikePrice && orderId) {
        //cancel order
        state.orderId = '';
        state.orderPrice = 0;
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = executedPrice * commission;
        breakEvenPrice = executedPrice + (executedPrice - strikePrice) + (2 * commissionCost);
        threshold = breakEvenPrice * (1 + thresholdPercent);

        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
    }

    if (havePosition && orderId) {
        //cancel order
        state.orderId = '';
        state.orderPrice = 0;
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    if (havePosition && threshold > 0 && bid >= threshold) {
        context.process = longITM;
    }

}

//ITM long state
async function longITM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, breakEvenPrice, orderPrice } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    if (havePosition && bid <= breakEvenPrice && orderId) {
        state.orderPrice = bid;
        //create order to sell to close position
        let price = `${round(bid, 2)}`;
        let qty = `${round(context.settings.size, 3)}`;

        //create sell order
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            reduceOnly: true,
            price,
            qty
        });
        state.orderId = order.orderId;
        return;
    }

    if (havePosition && bid <= breakEvenPrice && orderId && bid !== orderPrice) {
        state.orderPrice = bid;
        let price = `${round(bid, 2)}`;
        //update order
        let { result: order } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price
        });
        state.orderId = order.orderId;
        return;
    }

    if (havePosition && bid > breakEvenPrice && orderId) {
        //cancel order
        state.orderId = '';
        state.orderPrice = 0;
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    let transistionPrice = strikePrice * (1 - thresholdPercent);
    if (!havePosition && ask <= transistionPrice) {
        //transistion to OTM state
        state.breakEvenPrice = 0;
        state.threshold = 0;
        context.process = longOTM;
    }
}

//OTM short state
async function shortOTM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, entryPrice, breakEvenPrice, orderPrice, threshold } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    if (!havePosition && bid <= strikePrice && orderId) {
        state.orderPrice = bid;
        let price = `${round(bid, 2)}`;
        let qty = `${round(context.settings.size, 3)}`;

        //create sell order
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price,
            qty
        });
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && bid <= strikePrice && bid !== orderPrice && orderId) {
        state.orderPrice = bid;
        let price = `${round(bid, 2)}`;
        //update order
        let { result: order } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price
        });
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && bid > strikePrice && orderId) {
        //cancel order
        state.orderId = '';
        state.orderPrice = 0;
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = entryPrice * commission;
        breakEvenPrice = entryPrice - (strikePrice - entryPrice) - (2 * commissionCost);
        threshold = breakEvenPrice * (1 - thresholdPercent);
        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
    }

    if (havePosition && orderId) {
        //cancel order
        state.orderId = '';
        state.orderPrice = 0;
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    if (havePosition && threshold > 0 && ask <= threshold) {
        context.process = shortITM;
    }
}

//ITM short state
async function shortITM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, breakEvenPrice, orderPrice } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    if (havePosition && ask >= breakEvenPrice && orderId) {
        state.orderPrice = ask;
        //create order to buy to close position
        let price = `${round(bid, 2)}`;
        let qty = `${round(context.settings.size, 3)}`;

        //create buy order
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            reduceOnly: true,
            price,
            qty
        });
        state.orderId = order.orderId;
        return;
    }

    if (havePosition && ask >= breakEvenPrice && orderId && ask !== orderPrice) {
        state.orderPrice = ask;
        let price = `${round(bid, 2)}`;
        //update order
        let { result: order } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price
        });
        state.orderId = order.orderId;
        return;
    }

    if (havePosition && ask < breakEvenPrice && orderId) {
        //cancel order
        state.orderId = '';
        state.orderPrice = 0;
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    let transistionPrice = strikePrice * (1 + thresholdPercent);
    if (!havePosition && bid > transistionPrice) {
        context.process = shortOTM;
        state.breakEvenPrice = 0;
        state.threshold = 0;
    }
}

const commission = 0.0002;

dotenv.config({ override: true });

const
    keyPrefix = `${process.env.KEY_PREFIX}`,
    region = `${process.env.AWS_REGION}`,
    useTestNet = process.env.USE_TESTNET === 'true';

const ssm = new SSMClient({ region });
const apiCredentials = await getCredentials({ ssm, name: 'api-credentials', apiCredentialsKeyPrefix: keyPrefix });
const settings = await getSettings({ ssm, name: 'settings', keyPrefix });

let state: State = {
    bid: 0,
    ask: 0,
    position: 0,
    orderId: '',
    entryPrice: 0,
    breakEvenPrice: 0,
    orderPrice: 0,
    threshold: 0
} as State;

const socketClient = new WebsocketClient({
    market: 'v5',
    testnet: useTestNet,
    key: apiCredentials.apiKey,
    secret: apiCredentials.apiSecret
});

const restClient = new RestClientV5({
    testnet: useTestNet,
    secret: apiCredentials.apiSecret,
    key: apiCredentials.apiKey
});

let { result: { list: orders } } = await restClient.getActiveOrders({
    symbol: settings.symbol,
    category: 'linear'
});

if (orders.length > 0) {
    state.orderId = orders[0].orderId;
    state.orderPrice = parseFloat(orders[0].price);
}

let { result: { list: [position] } } = await restClient.getPositionInfo({
    symbol: settings.symbol,
    category: 'linear'
});

console.log(JSON.stringify(position));
socketClient.on('update', websocketCallback(state));

await socketClient.subscribeV5(`orderbook.1.${settings.symbol}`, 'linear');

let context: Context = {
    state,
    settings,
    restClient,
    process: longOTM
}

while (true) {
    await context.process(context);
    await asyncSleep(10);
}


//order placed
//position opened

//if the websocket is not closed, you can call client.close() to close it
//for buy
// if ask >= strikeprice
//   if noorder create order to buy at ask
//   if order exists update price to ask
// if ask < strikeprice cancel order
//once order is filled
// place stop loss order at 1% below the buy price
// what for price to cross threshold
// break even price = difference between the executed price and the strike price plus 2 x commission for trade (added to executed price for buy and subtracted from executed price for sell)
// threshold = 1% above break even price
// once price crosses threshold place order at break even price
