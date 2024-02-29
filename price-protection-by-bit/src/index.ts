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
    size: number
    orderId: string
    entryPrice: number
    breakEvenPrice: number
    orderPrice: number
    threshold: number
    executionTime: number
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
    state.size = Math.abs(parseFloat(data.data[0].size));
    state.entryPrice = parseFloat(data.data[0].entryPrice);
}

function orderUpdate(data: any, state: State) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    if (data.data[0].stopOrderType !== '') return;
    switch (data.data[0].orderStatus) {
        case 'Cancelled':
        case 'Rejected':
        case 'Filled':
        case 'Deactivated':
            state.orderId = '';
            break;
        case 'New':
            state.orderId = data.data[0].orderId;
            break;
    }
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
    let { bid, ask, size, orderId, entryPrice, breakEvenPrice, orderPrice, threshold } = state;
    let { strikePrice, thresholdPercent, coolDown } = context.settings;
    let havePosition = size >= context.settings.size;
    let coolDownEnabled = coolDown > 0;
    let executionEnabled = !coolDownEnabled || (state.executionTime > 0 && (new Date()).getTime() > state.executionTime);

    let price = round((bid + ask) / 2, 2);

    if (havePosition && orderId) {
        await context.restClient.cancelOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId
        });
        await Logger.log(`longOTM: cancelling order orderId:${orderId}`);
        state.orderId = '';
        return;
    }

    if (!havePosition && price < strikePrice && orderId) {
        await context.restClient.cancelOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId
        });
        await Logger.log(`longOTM: cancelling order orderId:${orderId}`);
        state.orderId = '';
        return;
    }

    if (!havePosition && ask >= strikePrice && state.executionTime === 0 && coolDownEnabled) {
        state.executionTime = (new Date()).getTime() + coolDown;
        return;
    }

    if (state.executionTime !== 0 && (ask < strikePrice || havePosition)) {
        state.executionTime = 0;
        return;
    }

    if (!havePosition && ask >= strikePrice && !orderId && executionEnabled) {
        state.orderPrice = price;
        let qty = `${round(Math.abs(context.settings.size - size), 3)}`;
        let symbol = context.settings.symbol;

        //create buy order
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price: `${price}`,
            slTriggerBy: 'MarkPrice',
            stopLoss: `${round(price * (1 - context.settings.slPercent), 2)}`,
            qty
        });
        await Logger.log(`longOTM: buy order price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && ask >= strikePrice && price !== orderPrice && orderId && executionEnabled) {
        state.orderPrice = price;
        //update order
        let { retCode, retMsg } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price: `${price}`
        });
        if (retCode === 110001 && retMsg === 'order not exists or too late to replace') {
            state.orderId = '';
            await Logger.log(`longOTM: update failed orderId:${orderId}`);
        }
        else {
            await Logger.log(`longOTM: ammend order price:${price} symbol:${context.settings.symbol} orderId:${state.orderId}`);
        }
        return;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = entryPrice * commission;
        breakEvenPrice = entryPrice + Math.abs(entryPrice - strikePrice) + (2 * commissionCost);
        threshold = breakEvenPrice * (1 + thresholdPercent);

        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
        await Logger.log(`longOTM: breakEvenPrice:${breakEvenPrice} threshold:${threshold}`);
    }

    if (havePosition && threshold > 0 && price >= threshold) {
        context.execution = longITM;
        await Logger.log(`longOTM: transistioning to long ITM state price:${price} threshold:${threshold}`);
    }

}

//ITM long state
async function longITM(context: Context) {
    let state = context.state;
    let { bid, ask, size, orderId, breakEvenPrice, orderPrice, entryPrice } = state;
    let { coolDown, strikePrice, thresholdPercent } = context.settings;
    let havePosition = size > 0;
    let coolDownEnabled = coolDown > 0;
    let executionEnabled = !coolDownEnabled || (state.executionTime > 0 && (new Date()).getTime() > state.executionTime);
    let price = round((bid + ask) / 2, 2);

    if (!havePosition && orderId) {
        state.orderId = '';
        await context.restClient.cancelOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId
        });
        await Logger.log(`longITM: cancelling order orderId:${orderId}`);
        return;
    }

    if (havePosition && bid <= breakEvenPrice && state.executionTime === 0 && coolDownEnabled) {
        state.executionTime = (new Date()).getTime() + coolDown;
        return;
    }

    if (state.executionTime !== 0 && (bid > strikePrice || !havePosition)) {
        state.executionTime = 0;
        return;
    }

    if (havePosition && breakEvenPrice === 0) {
        breakEvenPrice = entryPrice + Math.abs(entryPrice - strikePrice) + (2 * (entryPrice * commission));
        state.breakEvenPrice = breakEvenPrice;
        await Logger.log(`longITM: breakEvenPrice:${breakEvenPrice}`);
    }

    if (havePosition && bid <= breakEvenPrice && !orderId && executionEnabled) {
        state.orderPrice = price;
        //create order to sell to close position
        let qty = `${round(size, 3)}`;
        let symbol = context.settings.symbol;

        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            reduceOnly: true,
            price: `${price}`,
            qty
        });
        await Logger.log(`longITM: sell order (reduceonly) price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
        state.orderId = order.orderId;
        return;
    }

    if (havePosition && bid <= breakEvenPrice && orderId !== '' && price !== orderPrice && executionEnabled) {
        state.orderPrice = price;
        //update order
        let { retCode, retMsg } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price: `${price}`
        });
        if (retCode === 110001 && retMsg === 'order not exists or too late to replace') {
            state.orderId = '';
            await Logger.log(`longITM: update failed orderId:${orderId}`);
        }
        else {
            await Logger.log(`longITM: ammend order price:${price} symbol:${context.settings.symbol} orderId:${state.orderId}`);
        }
        return;
    }

    let transistionPrice = strikePrice * (1 - thresholdPercent);
    if (!havePosition && price <= transistionPrice) {
        await Logger.log(`longITM: transistioning to long OTM state price:${price} transistionPrice:${transistionPrice}`);

        state.breakEvenPrice = 0;
        state.threshold = 0;
        context.execution = longOTM;
    }
}

//OTM short state
async function shortOTM(context: Context) {
    let state = context.state;
    let { bid, ask, size, orderId, entryPrice, breakEvenPrice, orderPrice, threshold } = state;
    let { coolDown, strikePrice, thresholdPercent } = context.settings;
    let havePosition = size >= context.settings.size;
    let coolDownEnabled = coolDown > 0;
    let executionEnabled = !coolDownEnabled || (state.executionTime > 0 && (new Date()).getTime() > state.executionTime);

    let price = round((bid + ask) / 2, 2);

    if (havePosition && orderId) {
        await context.restClient.cancelOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId
        });
        await Logger.log(`shortOTM: cancelling order orderId:${orderId}`);
        state.orderId = '';
        return;
    }

    if (!havePosition && price > strikePrice && orderId) {
        await context.restClient.cancelOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId
        });
        await Logger.log(`shortOTM: cancelling order orderId:${orderId}`);
        state.orderId = '';
        return;
    }

    if (!havePosition && bid <= strikePrice && state.executionTime === 0 && coolDownEnabled) {
        state.executionTime = (new Date()).getTime() + coolDown;
        return;
    }

    if (state.executionTime !== 0 && (bid > strikePrice && havePosition)) {
        state.executionTime = 0;
        return;
    }

    if (!havePosition && bid <= strikePrice && !orderId && executionEnabled) {
        state.orderPrice = price;
        let qty = `${round(Math.abs(context.settings.size - size), 3)}`;
        let symbol = context.settings.symbol;

        //create sell order
        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price: `${price}`,
            stopLoss: `${round(price * (1 + context.settings.slPercent), 2)}`,
            qty
        });
        await Logger.log(`shortOTM: sell order price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
        state.orderId = order.orderId;
        return;
    }

    if (!havePosition && bid <= strikePrice && price !== orderPrice && orderId && executionEnabled) {
        state.orderPrice = price;
        //update order
        let { retCode, retMsg } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price: `${price}`
        });
        if (retCode === 110001 && retMsg === 'order not exists or too late to replace') {
            state.orderId = '';
            await Logger.log(`shortOTM: update failed orderId:${orderId}`);
        }
        else {
            await Logger.log(`shortOTM: ammend order price:${price} symbol:${context.settings.symbol} orderId:${state.orderId}`);
        }
        return;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = entryPrice * commission;
        breakEvenPrice = entryPrice - Math.abs(strikePrice - entryPrice) - (2 * commissionCost);
        threshold = breakEvenPrice * (1 - thresholdPercent);
        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
        await Logger.log(`shortOTM: breakEvenPrice:${breakEvenPrice} threshold:${threshold}`);
    }

    if (havePosition && threshold > 0 && price <= threshold) {
        context.execution = shortITM;

        await Logger.log(`shortOTM: transistioning to short  ITM state price:${price} threshold:${threshold}`);
    }
}

//ITM short state
async function shortITM(context: Context) {
    let state = context.state;
    let { bid, ask, size, orderId, breakEvenPrice, orderPrice } = state;
    let { coolDown, strikePrice, thresholdPercent } = context.settings;
    let havePosition = size > 0;
    let coolDownEnabled = coolDown > 0;
    let executionEnabled = !coolDownEnabled || (state.executionTime > 0 && (new Date()).getTime() > state.executionTime);

    let price = round((bid + ask) / 2, 2);

    if (!havePosition && orderId) {
        await context.restClient.cancelOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId
        });
        await Logger.log(`shortITM: cancelling order orderId:${orderId}`);
        state.orderId = '';
        return;
    }

    if (havePosition && ask >= breakEvenPrice && state.executionTime === 0 && coolDownEnabled) {
        state.executionTime = (new Date()).getTime() + coolDown;
        return;
    }

    if (state.executionTime !== 0 && (ask < strikePrice && !havePosition)) {
        state.executionTime = 0;
        return;
    }

    if (havePosition && ask >= breakEvenPrice && !orderId && executionEnabled) {
        state.orderPrice = price;
        //create order to buy to close position
        let qty = `${round(size, 3)}`
        let symbol = context.settings.symbol

        let { result: order } = await context.restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            reduceOnly: true,
            price: `${price}`,
            qty
        });

        await Logger.log(`shortITM: buy order (reduceonly) price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
        state.orderId = order.orderId;
        return;
    }

    if (havePosition && ask >= breakEvenPrice && orderId && price !== orderPrice && executionEnabled) {
        state.orderPrice = price;
        //update order

        let { retCode, retMsg } = await context.restClient.amendOrder({
            symbol: context.settings.symbol,
            category: 'linear',
            orderId,
            price: `${price}`
        });
        if (retCode === 110001 && retMsg === 'order not exists or too late to replace') {
            state.orderId = '';
            await Logger.log(`shortITM: update failed orderId:${orderId}`);
        }
        else {
            await Logger.log(`shortITM: ammend order price:${price} symbol:${context.settings.symbol} orderId:${state.orderId}`);
        }
        return;
    }

    let transistionPrice = strikePrice * (1 + thresholdPercent);
    if (!havePosition && price > transistionPrice) {
        await Logger.log(`shortITM: transistioning to short OTM state bid:${price} transistionPrice:${transistionPrice}`);

        context.execution = shortOTM;
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
        size: 0,
        orderId: '',
        entryPrice: 0,
        breakEvenPrice: 0,
        orderPrice: 0,
        threshold: 0,
        executionTime: 0
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

    orders = orders.filter(o => !o.triggerPrice)
    if (orders && orders.length > 0) {
        state.orderId = orders[0].orderId;
        state.orderPrice = parseFloat(orders[0].price);
    }

    let { result: { list: [position] } } = await restClient.getPositionInfo({
        symbol: settings.symbol,
        category: 'linear'
    });

    if (position && position.positionValue) {
        state.size = Math.abs(parseFloat(position.size));
        state.entryPrice = parseFloat(position.avgPrice);
    }

    if (state.size > 0 && state.entryPrice > 0 && settings.direction === 'long') {
        let commissionCost = state.entryPrice * commission;
        state.breakEvenPrice = state.entryPrice + Math.abs(state.entryPrice - settings.strikePrice) + (2 * commissionCost);
        state.threshold = state.breakEvenPrice * (1 + settings.thresholdPercent);
    }

    if (state.size > 0 && state.entryPrice > 0 && settings.direction === 'short') {
        let commissionCost = state.entryPrice * commission;
        state.breakEvenPrice = state.entryPrice - Math.abs(state.entryPrice - settings.strikePrice) - (2 * commissionCost);
        state.threshold = state.breakEvenPrice * (1 - settings.thresholdPercent);
    }

    socketClient.on('update', websocketCallback(state));

    await socketClient.subscribeV5(`orderbook.1.${settings.symbol}`, 'linear');
    await socketClient.subscribeV5('order', 'linear');
    await socketClient.subscribeV5('position', 'linear');

    let execution = settings.direction === 'long' ? longOTM : shortOTM;
    if (state.entryPrice > 0 && state.entryPrice > settings.strikePrice && settings.direction === 'long') execution = longITM;
    if (state.entryPrice > 0 && state.entryPrice < settings.strikePrice && settings.direction === 'short') execution = shortITM;

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
    let err = error as Error;
    await Logger.log(`error: message:${err.message} stack:${err.stack}`);
    process.exit(1);
}