import { setTimeout as asyncSleep } from 'timers/promises';
import { RestClientV5, WebsocketClient } from 'bybit-api'

const client = new WebsocketClient({
    market: 'v5'
});

type State = {
    bid: number;
    ask: number;
    position: number;
    orderId: number;
    entryPrice: number;
    breakEvenPrice: number;
    orderPrice: number;
    threshold: number;
}

type Settings = {
    strikePrice: number;
    thresholdPercent: number;
    direction: 'long' | 'short';
    slPercent: number;
    commission: number;
    symbol: string;
}

type Context = {
    state: State;
    settings: Settings;
    process: (context: Context) => Promise<void>;
}

function setupCallbackWithState(state: State): (response: any) => void {
    return (data) => {
        if (!data || !data.data || !data.data.b || !data.data.a) return;
        if (data.data.b.length > 0 && data.data.b[0].length > 0) state.bid = data.data.b[0][0];
        if (data.data.a.length > 0 && data.data.a[0].length > 0) state.ask = data.data.a[0][0];
    }
}

//OTM state
async function longOTM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, entryPrice: executedPrice, breakEvenPrice, orderPrice, threshold } = state;
    let { strikePrice, thresholdPercent, commission } = context.settings;
    let havePosition = position !== 0;

    if (!havePosition && ask >= strikePrice && orderId === 0) {
        state.orderPrice = ask;
        //create order
    }

    if (!havePosition && ask >= strikePrice && ask !== orderPrice && orderId !== 0) {
        state.orderPrice = ask;
        //update order
    }

    if (!havePosition && ask < strikePrice && orderId !== 0) {
        //cancel order
        state.orderId = 0;
        state.orderPrice = 0;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = executedPrice * commission;
        breakEvenPrice = executedPrice + (executedPrice - strikePrice) + (2 * commissionCost);
        threshold = breakEvenPrice * (1 + thresholdPercent);

        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
    }

    if (havePosition && orderId !== 0) {
        //cancel order
        state.orderId = 0;
        state.orderPrice = 0;
    }

    if (havePosition && threshold > 0 && bid >= threshold) {
        context.process = longITM;
    }

}

async function longITM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, breakEvenPrice, orderPrice } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    if (havePosition && bid <= breakEvenPrice && orderId === 0) {
        state.orderPrice = bid;
        //create order to sell to close position
    }

    if (havePosition && bid <= breakEvenPrice && orderId !== 0 && bid !== orderPrice) {
        state.orderPrice = bid;
        //update order
    }

    if (havePosition && bid > breakEvenPrice && orderId !== 0) {
        //cancel order
        state.orderId = 0;
        state.orderPrice = 0;
    }

    let transistionPrice = strikePrice * (1 - thresholdPercent);
    if (!havePosition && ask <= transistionPrice) {
        //transistion to OTM state
        state.breakEvenPrice = 0;
        state.threshold = 0;
        context.process = longOTM;
    }
}

//OTM state
async function shortOTM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, entryPrice: executedPrice, breakEvenPrice, orderPrice, threshold } = state;
    let { strikePrice, thresholdPercent, commission } = context.settings;
    let havePosition = position !== 0;

    if (!havePosition && bid <= strikePrice && orderId === 0) {
        state.orderPrice = bid;
        //create sell order
    }

    if (!havePosition && bid <= strikePrice && bid !== orderPrice && orderId !== 0) {
        state.orderPrice = bid;
        //update order
    }

    if (!havePosition && bid > strikePrice && orderId !== 0) {
        //cancel order
        state.orderId = 0;
        state.orderPrice = 0;
    }

    if (havePosition && (threshold === 0 || breakEvenPrice === 0)) {
        let commissionCost = executedPrice * commission;
        breakEvenPrice = executedPrice - (strikePrice - executedPrice) - (2 * commissionCost);
        threshold = breakEvenPrice * (1 - thresholdPercent);
        state.breakEvenPrice = breakEvenPrice;
        state.threshold = threshold;
    }

    if (havePosition && orderId !== 0) {
        //cancel order
        state.orderId = 0;
        state.orderPrice = 0;
    }

    if (havePosition && threshold > 0 && ask <= threshold) {
        context.process = shortITM;
    }
}

async function shortITM(context: Context) {
    let state = context.state;
    let { bid, ask, position, orderId, breakEvenPrice, orderPrice } = state;
    let { strikePrice, thresholdPercent } = context.settings;
    let havePosition = position !== 0;

    if (havePosition && ask >= breakEvenPrice && orderId === 0) {
        state.orderPrice = ask;
        //create order to sell to close position
    }

    if (havePosition && ask >= breakEvenPrice && orderId !== 0 && ask !== orderPrice) {
        state.orderPrice = ask;
        //update order
    }

    if (havePosition && ask < breakEvenPrice && orderId !== 0) {
        //cancel order
        state.orderId = 0;
        state.orderPrice = 0;
    }

    let transistionPrice = strikePrice * (1 + thresholdPercent);
    if (!havePosition && bid > transistionPrice) {
        context.process = shortOTM;
        state.breakEvenPrice = 0;
        state.threshold = 0;
    }
}



let state: State = {} as State;
let settings: Settings = {
    strikePrice: 0,
    thresholdPercent: 0,
    direction: 'long',
    slPercent: 0,
    commission: 0,
    symbol: ''
};

client.on('update', setupCallbackWithState(state));

await client.subscribeV5(`orderbook.1.${settings.symbol}`, 'linear');

let context: Context = {
    state,
    settings,
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
