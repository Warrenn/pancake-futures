import { setTimeout as asyncSleep } from 'timers/promises';
import { RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';
import { Logger } from './logger.js';

const commission = 0.0002;

type State = {
    bid: number
    ask: number
    position: number
    orderId: string
    entryPrice: number
    breakEvenPrice: number
    orderPrice: number
    threshold: number
    pastCoolDown: boolean
}

type Credentials = {
    apiKey: string
    apiSecret: string
}

type Settings = {
    strikePrice: number
    thresholdPercent: number
    direction: 'long' | 'short'
    coolDown: number
    slPercent: number
    symbol: string
    size: number
}

type Context = {
    state: State
    settings: Settings
    restClient: RestClientV5
    execution: (context: Context) => Promise<void>
}

function orderbookUpdate(data: any, state: State) {
    if (!data || !data.data || !data.data.b || !data.data.a) return;
    if (data.data.b.length > 0 && data.data.b[0].length > 0) state.bid = parseFloat(data.data.b[0][0]);
    if (data.data.a.length > 0 && data.data.a[0].length > 0) state.ask = parseFloat(data.data.a[0][0]);
}

function positionUpdate(data: any, state: State) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    state.orderId = '';
    state.position = parseFloat(data.data[0].positionValue);
    state.entryPrice = parseFloat(data.data[0].entryPrice);
    state.pastCoolDown = false;
}

function orderUpdate(data: any, state: State) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    state.orderId = data.data[0].orderId;
    state.pastCoolDown = false;
}

function executionUpdate(data: any, state: State) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    state.orderId = '';
    state.pastCoolDown = false;
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
            case 'position':
                positionUpdate(data, state);
                break;
            case 'order':
                orderUpdate(data, state);
                break;
            case 'execution':
                executionUpdate(data, state);
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
    let { bid, ask, position, orderId, entryPrice, breakEvenPrice, orderPrice, threshold, pastCoolDown } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position > 0;

    bid = round(bid, 2);
    ask = round(ask, 2);

    if (!havePosition && !pastCoolDown && ask >= strikePrice) {
        await Logger.log(`longOTM: waiting for cool down ask:${ask} strikePrice:${strikePrice} pastCoolDown:${pastCoolDown}`);
        await asyncSleep(context.settings.coolDown);
        state.pastCoolDown = true;
        return;
    }

    if (!havePosition && ask < strikePrice) {
        state.pastCoolDown = false;
    }

    if (!havePosition && ask >= strikePrice && orderId === '' && pastCoolDown) {
        state.orderPrice = ask;
        let price = `${state.orderPrice}`;
        let qty = `${round(context.settings.size, 3)}`;
        let symbol = context.settings.symbol;

        //create buy order
        await Logger.log(`longOTM: buy order price:${price} qty:${qty} symbol:${symbol}`);
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price,
            qty
        });
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && ask >= strikePrice && ask !== orderPrice && orderId !== '' && pastCoolDown) {
        state.orderPrice = ask;
        let price = `${state.orderPrice}`;
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

    if (!havePosition && ask < strikePrice && orderId !== '') {
        //cancel order
        let symbol = `${context.settings.symbol}`;
        state.orderId = '';
        state.orderPrice = 0;
        state.pastCoolDown = false;

        await Logger.log(`longOTM: cancelling order orderId:${orderId} symbol:${symbol}`);
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol,
            orderId
        });
        return;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = entryPrice * commission;
        breakEvenPrice = entryPrice + Math.abs(entryPrice - strikePrice) + (2 * commissionCost);
        threshold = breakEvenPrice * (1 + thresholdPercent);

        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
    }

    if (havePosition && threshold > 0 && bid >= threshold) {
        context.execution = longITM;
        state.pastCoolDown = false;
        await Logger.log(`longOTM: transistioning to long ITM state bid:${bid} threshold:${threshold}`);
    }

}

//ITM long state
async function longITM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, breakEvenPrice, orderPrice, entryPrice } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position > 0;

    bid = round(bid, 2);
    ask = round(ask, 2);

    if (havePosition && !(breakEvenPrice > 0)) {
        breakEvenPrice = entryPrice + Math.abs(strikePrice - entryPrice) + (2 * (entryPrice * commission));
        state.breakEvenPrice = breakEvenPrice;
    }

    if (havePosition && bid <= breakEvenPrice && orderId === '') {
        state.orderPrice = bid;
        //create order to sell to close position
        let price = `${state.orderPrice}`;
        let qty = `${round(context.settings.size, 3)}`;
        let symbol = context.settings.symbol;

        await Logger.log(`longITM: sell order (reduceonly) price:${price} qty:${qty} symbol:${symbol}`);
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
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

    if (havePosition && bid <= breakEvenPrice && orderId !== '' && bid !== orderPrice) {
        state.orderPrice = bid;
        let price = `${state.orderPrice}`;
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

    if (havePosition && bid > breakEvenPrice && orderId !== '') {
        let symbol = context.settings.symbol;
        state.orderId = '';
        state.orderPrice = 0;

        await Logger.log(`longITM: cancelling order orderId:${orderId} symbol:${symbol}`);
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol,
            orderId
        });
        return;
    }

    let transistionPrice = strikePrice * (1 - thresholdPercent);
    if (!havePosition && ask <= transistionPrice) {
        await Logger.log(`longITM: transistioning to long OTM state ask:${ask} transistionPrice:${transistionPrice}`);

        state.breakEvenPrice = 0;
        state.threshold = 0;
        state.pastCoolDown = false;
        context.execution = longOTM;
    }
}

//OTM short state
async function shortOTM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, entryPrice, breakEvenPrice, orderPrice, threshold, pastCoolDown } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position > 0;

    bid = round(bid, 2);
    ask = round(ask, 2);

    if (!havePosition && !pastCoolDown && bid <= strikePrice) {
        await Logger.log(`shortOTM: waiting for cool down ask:${bid} strikePrice:${strikePrice} pastCoolDown:${pastCoolDown}`);
        await asyncSleep(context.settings.coolDown);
        state.pastCoolDown = true;
        return;
    }

    if (!havePosition && bid > strikePrice) {
        state.pastCoolDown = false;
    }

    if (!havePosition && bid <= strikePrice && orderId === '' && pastCoolDown) {
        state.orderPrice = bid;
        let price = `${state.orderPrice}`;
        let qty = `${round(context.settings.size, 3)}`
        let symbol = context.settings.symbol

        //create sell order
        await Logger.log(`shortOTM: sell order price:${price} qty:${qty} symbol:${symbol}`);
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price,
            qty
        });
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && bid <= strikePrice && bid !== orderPrice && orderId !== '' && pastCoolDown) {
        state.orderPrice = bid;
        let price = `${state.orderPrice}`;
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

    if (!havePosition && bid > strikePrice && orderId !== '') {
        //cancel order
        //log('canceling order');
        let symbol = context.settings.symbol;
        state.orderId = '';
        state.orderPrice = 0;
        state.pastCoolDown = false;

        await Logger.log(`shortOTM: cancelling order orderId:${orderId} symbol:${symbol}`);
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol,
            orderId
        });
        return;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = entryPrice * commission;
        breakEvenPrice = entryPrice - Math.abs(strikePrice - entryPrice) - (2 * commissionCost);
        threshold = breakEvenPrice * (1 - thresholdPercent);
        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
    }

    if (havePosition && threshold > 0 && ask <= threshold) {
        state.pastCoolDown = false;
        context.execution = shortITM;

        await Logger.log(`shortOTM: transistioning to short  ITM state ask:${ask} threshold:${threshold}`);
    }
}

//ITM short state
async function shortITM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, breakEvenPrice, orderPrice } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    bid = round(bid, 2);
    ask = round(ask, 2);

    if (havePosition && ask >= breakEvenPrice && orderId === '') {
        state.orderPrice = ask;
        //create order to buy to close position
        let price = `${state.orderPrice}`;
        let qty = `${round(context.settings.size, 3)}`
        let symbol = context.settings.symbol

        await Logger.log(`shortITM: buy order (reduceonly) price:${price} qty:${qty} symbol:${symbol}`);
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
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

    if (havePosition && ask >= breakEvenPrice && orderId !== '' && ask !== orderPrice) {
        state.orderPrice = ask;
        let price = `${state.orderPrice}`;
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

    if (havePosition && ask < breakEvenPrice && orderId !== '') {
        let symbol = context.settings.symbol;
        state.orderId = '';
        state.orderPrice = 0;

        await Logger.log(`shortITM: cancelling order orderId:${orderId} symbol:${symbol}`);
        await context.restClient.cancelOrder({
            category: 'linear',
            symbol: context.settings.symbol,
            orderId
        });
        return;
    }

    let transistionPrice = strikePrice * (1 + thresholdPercent);
    if (!havePosition && bid > transistionPrice) {
        await Logger.log(`shortITM: transistioning to short OTM state bid:${bid} transistionPrice:${transistionPrice}`);

        context.execution = shortOTM;
        state.pastCoolDown = false;
        state.breakEvenPrice = 0;
        state.threshold = 0;
    }
}

dotenv.config({ override: true });

await Logger.setLoggerFundingRound((new Date()).getTime());
await Logger.log('starting');

const
    keyPrefix = `${process.env.KEY_PREFIX}`,
    region = `${process.env.AWS_REGION}`,
    useTestNet = process.env.USE_TESTNET === 'true';

try {
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

    if (position && position.positionValue) {
        state.position = parseFloat(position.positionValue);
        state.entryPrice = parseFloat(position.avgPrice);
    }

    if (state.position > 0 && state.entryPrice > 0 && settings.direction === 'long') {
        let commissionCost = state.entryPrice * commission;
        state.breakEvenPrice = state.entryPrice + Math.abs(state.entryPrice - settings.strikePrice) + (2 * commissionCost);
        state.threshold = state.breakEvenPrice * (1 + settings.thresholdPercent);
    }

    if (state.position > 0 && state.entryPrice > 0 && settings.direction === 'short') {
        let commissionCost = state.entryPrice * commission;
        state.breakEvenPrice = state.entryPrice - Math.abs(state.entryPrice - settings.strikePrice) - (2 * commissionCost);
        state.threshold = state.breakEvenPrice * (1 - settings.thresholdPercent);
    }

    socketClient.on('update', websocketCallback(state));

    await socketClient.subscribeV5(`orderbook.1.${settings.symbol}`, 'linear');
    await socketClient.subscribeV5('execution', 'linear');
    await socketClient.subscribeV5('order', 'linear');
    await socketClient.subscribeV5('position', 'linear');

    let execution = settings.direction === 'long' ? longOTM : shortOTM;
    if (state.entryPrice > settings.strikePrice && settings.direction === 'long') execution = longITM;
    if (state.entryPrice < settings.strikePrice && settings.direction === 'short') execution = shortITM;

    await Logger.log(`state: ${JSON.stringify(state)}`);
    await Logger.log(`settings: ${JSON.stringify(settings)}`);
    await Logger.log(`execution: ${execution.name}`);

    let context: Context = {
        state,
        settings,
        restClient,
        execution
    }

    while (true) {
        await context.execution(context);
        await asyncSleep(10);
    }
}
catch (error) {
    await Logger.log(`error: ${error}`);
}