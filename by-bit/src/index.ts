import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, AccountAssetClient, WebsocketClient, UnifiedMarginClient } from "bybit-api";
import { v4 as uuid } from 'uuid';
import AWS from 'aws-sdk';
import dotenv from "dotenv";

type Position = { free: number, loan: number, tokenId: string };
type OptionPosition = { symbol: string, markPrice: string, unrealisedPnl: string, entryPrice: string, size: string, limit: number };

dotenv.config({ override: true });

const
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
    minSizes: { [id: string]: number } = {
        ETH: 0.08,
        NEAR: 1,
        USDT: 10,
        USDC: 10
    },
    credentialsKey = `${process.env.BYBIT_API_CREDENTIALS}`,
    settingsKey = `${process.env.BYBIT_SETTINGS}`,
    region = `${process.env.BYBIT_REGION}`;

let
    slippage: number = 0,
    symbol: string = '',
    baseCurrency: string = '',
    quoteCurrency: string = '',
    optionInterval: number = 0,
    tradeMargin: number = 0,
    optionPrecision: number = 0,
    quotePrecision: number = 0,
    basePrecision: number = 0,
    logFrequency: number = 0,
    useTestnet: boolean = false,
    leverage: number = 0,
    optionIM: number = 0.285;

let
    strikePrice: number = 0,
    initialEquity: number = 0,
    size: number = 0,
    currentMoment: Date,
    expiryTime: Date | null = null,
    client: SpotClientV3,
    assetsClient: AccountAssetClient,
    unifiedClient: UnifiedMarginClient,
    wsSpot: WebsocketClient | null = null,
    optionsNeedUpdate: boolean = false,
    positionsNeedUpdate: boolean = false,
    callOption: OptionPosition | null = null,
    putOption: OptionPosition | null = null,
    basePosition: Position,
    quotePosition: Position,
    expiry: Date | null = null,
    bidPrice: number = 0,
    askPrice: number = 0,
    logCount: number = 0,
    ssm: AWS.SSM | null = null;

function floor(num: number, precision: number = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}

async function immediateSell(symbol: string, orderQty: number, price: number, coin: string = baseCurrency) {
    orderQty = floor(orderQty, basePrecision);
    if (orderQty <= (minSizes[coin] || 0)) return;
    positionsNeedUpdate = true;

    while (true) {
        price = floor(price, quotePrecision)
        log(`immediate sell qty: ${orderQty} at ${price}`);

        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
            side: "Sell",
            symbol: symbol,
            timeInForce: "IOC"
        });

        if (orderResponse.retCode == 12229) {
            await logError(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = floor(orderQty, basePrecision);
            ({ result: { price } } = await client.getLastTradedPrice(symbol));
            if (orderQty > 0) continue;
            return;
        }

        if (orderResponse.retCode == 0) return;

        await logError(orderResponse.retMsg);
        return;
    }
}

async function immediateBuy(symbol: string, orderQty: number, price: number, quoteCoin: string = quoteCurrency) {
    orderQty = floor(orderQty, basePrecision);
    if (orderQty <= ((minSizes[quoteCurrency] || 0) / price)) return;
    positionsNeedUpdate = true;

    while (true) {
        price = floor(price, quotePrecision)
        log(`immediate buy qty: ${orderQty} at ${price}`);

        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
            side: "Buy",
            symbol: symbol,
            timeInForce: "IOC"
        });

        if (orderResponse.retCode == 12228) {
            await logError(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * price, quotePrecision);
            ({ result: { price } } = await client.getLastTradedPrice(symbol));
            continue;
        }

        if (orderResponse.retCode == 0) return;

        await logError(orderResponse.retMsg);
        return;
    }
}

async function borrowIfRequired(coin: string, quantity: number, precision: number = quotePrecision) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`borrowIfRequired ${response.retMsg}`);
        return;
    }

    let { result: { loanAccountList } } = response;
    let position = getPosition(loanAccountList, coin, precision);
    log(`borrowIfRequired free:${position.free} quantity: ${quantity}`)
    if (position.free >= quantity) return;

    let diff = floor(quantity - position.free, precision);
    if (diff == 0) return;
    positionsNeedUpdate = true;
    await borrowFunds(coin, diff);
}

async function getSellableAmount(coin: string, quantity: number): Promise<number> {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`getSellableAmount ${response.retMsg}`);
        return quantity;
    }
    let { result: { loanAccountList } } = response;
    let position = getPosition(loanAccountList, coin, basePrecision);
    return Math.min(quantity, position.free);
}

async function borrowFunds(coin: string, quantity: number) {
    if (!!minSizes[coin] && quantity < minSizes[coin]) quantity = minSizes[coin];
    log(`borrow ${coin} ${quantity}`);
    positionsNeedUpdate = true;
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);

    if (borrowResponse.retCode == 0) return;
    await logError(`borrowFunds ${borrowResponse.retMsg}`);
}

async function log(message: string) {
    let logLine = `${(new Date()).toISOString()} ${message}`;
    console.log(logLine);
}

async function consoleAndFile(message: string) {
    console.log(message);
    console.error(message);
}

async function logError(message: string) {
    await consoleAndFile((new Date()).toISOString());
    await consoleAndFile(message);
}

function calculateNetEquity(basePosition: Position, quotePosition: Position, price: number): number {
    let qouteTotal = quotePosition.free - quotePosition.loan;
    let baseTotal = (basePosition.free - basePosition.loan) * price;
    return floor(qouteTotal + baseTotal, quotePrecision);
}

async function settleAccount(position: Position, price: number) {
    log(`Settling account free: ${position.free} loan: ${position.loan} price: ${price}`);
    positionsNeedUpdate = true;
    if (position.free < position.loan) {
        let buyAmount = floor(position.loan - position.free, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
    }
    if (position.free > position.loan) {
        let sellAmount = floor(position.free - position.loan, basePrecision);;
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
    }
}

function getPosition(loanAccountList: Position[], tokenId: string, precision: number): Position {
    let position = (<Position[]>loanAccountList).find(item => item.tokenId == tokenId) || { free: 0, loan: 0, tokenId };
    position.free = floor(position.free, precision);
    position.loan = floor(position.loan, precision);
    return position;
}

function getOptionSymbols(price: number): { putSymbol: string, callSymbol: string } {
    let contractPrice = Math.floor(price / optionInterval) * optionInterval;
    let halfInterval = optionInterval / 2;
    let strikePrice = (price % optionInterval) < halfInterval ? contractPrice : contractPrice + optionInterval;

    let expiryTime = new Date();
    expiryTime.setUTCDate(expiryTime.getUTCDate() + ((expiryTime.getUTCHours() < 8) ? 0 : 1));
    expiryTime.setUTCHours(8);
    expiryTime.setUTCMinutes(0);
    expiryTime.setUTCSeconds(0);
    expiryTime.setUTCMilliseconds(0);

    let yearStr = `${expiryTime.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);

    let putSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${strikePrice}-P`;
    let callSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${strikePrice}-C`;
    return { putSymbol, callSymbol };
}

async function placeStraddle(price: number, size: number): Promise<Date | null> {
    let { putSymbol, callSymbol } = getOptionSymbols(price);

    log(`Placing straddle price:${price} size:${size} put:${putSymbol} call:${callSymbol}`);
    var { retCode, retMsg } = await unifiedClient.submitOrder({
        category: 'option',
        orderType: 'Market',
        side: 'Sell',
        qty: `${size}`,
        symbol: putSymbol,
        timeInForce: 'ImmediateOrCancel',
        orderLinkId: `${uuid()}`
    });
    if (retCode != 0) logError(`put order failed ${putSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);

    var { retCode, retMsg } = await unifiedClient.submitOrder({
        category: 'option',
        orderType: 'Market',
        qty: `${size}`,
        side: 'Sell',
        symbol: callSymbol,
        timeInForce: 'ImmediateOrCancel',
        orderLinkId: `${uuid()}`
    });
    if (retCode != 0) logError(`call order failed ${callSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);

    optionsNeedUpdate = true;
    return expiryTime;
}

async function getPositions(): Promise<{ basePosition: Position, quotePosition: Position }> {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let basePosition = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, basePrecision);
    return { basePosition, quotePosition };
}

async function reconcileLoan(basePosition: Position, quantity: number, price: number) {
    if (basePosition.loan == quantity) return;
    positionsNeedUpdate = true;

    if (basePosition.loan < quantity) {
        let borrowAmount = floor(quantity - basePosition.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        return;
    }

    let repayment = floor(basePosition.loan - quantity, basePrecision);
    if (repayment == 0) return;
    if (repayment > basePosition.free) {
        let buyAmount = repayment - basePosition.free;
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
    }

    while (true) {
        let { retCode, retMsg } = await client.repayCrossMarginLoan(baseCurrency, `${repayment}`);
        if (retCode == 0 || retCode == 12000) return;
        logError(`couldn't reconcile loan:${basePosition.loan} free:${basePosition.free} quantity:${quantity} repayment:${repayment} (${retCode}) ${retMsg}`);
    }
}

async function executeTrade({
    strikePrice,
    size,
    basePosition,
    quotePosition,
    initialEquity,
    askPrice,
    bidPrice
}: {
    strikePrice: number,
    size: number,
    basePosition: Position,
    quotePosition: Position,
    initialEquity: number,
    askPrice: number,
    bidPrice: number
}) {

    let netEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);
    if ((logCount % logFrequency) == 0) {
        log(`f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} q:${size} sp:${strikePrice} ne:${netEquity} ie:${initialEquity} gp:${(netEquity - initialEquity)} c(${callOption?.symbol}):${callOption?.unrealisedPnl} p(${putOption?.symbol}):${putOption?.unrealisedPnl}`);
        logCount = 1;
    }
    else logCount++;

    let netPosition = floor(basePosition.free - basePosition.loan, basePrecision);
    if (bidPrice < strikePrice && askPrice > strikePrice && Math.abs(netPosition) > 0.0001) {
        log(`settle account f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} q:${size} np:${netPosition} sp:${strikePrice} ne:${netEquity} ie:${initialEquity} gp:${(netEquity - initialEquity)}`);
        await settleAccount(basePosition, askPrice);
        return;
    }

    let longAmount = floor(size - netPosition, basePrecision);
    if (bidPrice > strikePrice && longAmount > 0) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(strikePrice * (1 + slippage), quotePrecision);
        log(`upper f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} q:${size} la:${longAmount} sp:${strikePrice} ne:${netEquity} ie:${initialEquity} gp:${(netEquity - initialEquity)}`);
        await immediateBuy(symbol, buyAmount, buyPrice);
        return;
    }

    if (askPrice < strikePrice && basePosition.free > 0) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(strikePrice * (1 - slippage), quotePrecision);
        log(`lower f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} q:${size} la:${longAmount} sp:${strikePrice} ne:${netEquity} ie:${initialEquity} gp:${(netEquity - initialEquity)}`);
        await immediateSell(symbol, sellAmount, sellPrice);
    }
}

async function splitEquity(unifiedAmount: number) {
    unifiedAmount = floor(unifiedAmount, quotePrecision);
    if (unifiedAmount == 0) return;
    positionsNeedUpdate = true;

    if (unifiedAmount > 0) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${unifiedAmount}`,
            coin: quoteCurrency,
            from_account_type: "SPOT",
            to_account_type: "UNIFIED",
            transfer_id: `${uuid()}`
        });
        if (ret_code != 0) logError(`Failed to split Equity ${quoteCurrency} ${unifiedAmount} (${ret_code}) SPOT -> UNIFIED ${ret_msg}`);
        return
    }

    var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
        amount: `${Math.abs(unifiedAmount)}`,
        coin: quoteCurrency,
        from_account_type: "UNIFIED",
        to_account_type: "SPOT",
        transfer_id: `${uuid()}`
    });
    if (ret_code != 0) logError(`Failed to split Equity ${quoteCurrency} ${Math.abs(unifiedAmount)} (${ret_code}) UNIFIED -> SPOT ${ret_msg}`);
}

async function getOptions(): Promise<{
    callOption: OptionPosition | null,
    putOption: OptionPosition | null,
    expiry: Date | null
}> {
    let
        { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency }),
        checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`),
        callOption: OptionPosition | null = null,
        putOption: OptionPosition | null = null,
        expiry: Date | null = null;

    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = <OptionPosition>list[c];
        let matches = optionPosition.symbol.match(checkExpression);

        if (!matches) continue;
        if (parseFloat(optionPosition.size) == 0) continue;
        optionPosition.limit = parseFloat(matches[4]);

        if (matches[5] == 'P') putOption = optionPosition;
        if (matches[5] == 'C') callOption = optionPosition;
        if (expiry != null) continue;

        let mIndex = months.indexOf(matches[2]);
        expiry = new Date();
        let newYear = parseInt(`20${matches[3]}`);
        expiry.setUTCDate(parseInt(matches[1]));
        expiry.setUTCHours(8);
        expiry.setUTCMinutes(0);
        expiry.setUTCSeconds(0);
        expiry.setUTCMilliseconds(0);
        expiry.setUTCMonth(mIndex);
        expiry.setUTCFullYear(newYear);
    }

    return { callOption, putOption, expiry };
}

async function moveFundsToSpot() {
    let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
    if (!coin || coin.length == 0 || coin[0].availableBalance == 0) return

    let amount = floor(coin[0].availableBalance, quotePrecision) - 1;
    positionsNeedUpdate = true;
    if (amount <= 0) return;

    while (true) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${amount}`,
            coin: quoteCurrency,
            from_account_type: "UNIFIED",
            to_account_type: "SPOT",
            transfer_id: `${uuid()}`
        });
        if (ret_code == 0 || ret_code == 10006 || ret_code == 90001) return;
        logError(`Failed to move funds to SPOT ${quoteCurrency} ${Math.abs(amount)} UNIFIED -> SPOT ${ret_code} ${ret_msg}`);
    }
}

function closeWebSocket(socket: WebsocketClient | null) {
    try {
        if (socket == null) return;
        socket.closeAll(true);
    } catch (err) {
        logError(`couldnt close socket: ${err}`);
    }
}

process.stdin.on('data', process.exit.bind(process, 0));
ssm = new AWS.SSM({ region });

let authenticationParameter = await ssm.getParameter({ Name: credentialsKey, WithDecryption: true }).promise();
const { key, secret } = JSON.parse(`${authenticationParameter.Parameter?.Value}`);

let settingsParameter = await ssm.getParameter({ Name: settingsKey }).promise();
({
    slippage, baseCurrency, quoteCurrency, optionInterval, leverage,
    tradeMargin, optionPrecision, quotePrecision, basePrecision,
    optionIM, logFrequency, useTestnet
} = JSON.parse(`${settingsParameter.Parameter?.Value}`));

symbol = `${baseCurrency}${quoteCurrency}`;

while (true) {

    try {
        client = new SpotClientV3({
            testnet: useTestnet,
            key: key,
            secret: secret,
            recv_window: 999999
        });

        assetsClient = new AccountAssetClient({
            testnet: useTestnet,
            key: key,
            secret: secret,
            recv_window: 999999
        });

        unifiedClient = new UnifiedMarginClient({
            testnet: useTestnet,
            key: key,
            secret: secret,
            recv_window: 999999
        });

        wsSpot = new WebsocketClient({
            testnet: useTestnet,
            key: key,
            secret: secret,
            fetchTimeOffsetBeforeAuth: true,
            market: 'spotv3'
        });

        wsSpot.on('update', (data) => {
            if (data?.topic == 'outboundAccountInfo') positionsNeedUpdate = true;
            if (data?.topic == `bookticker.${symbol}` && data.data?.ap && data.data?.bp) {
                bidPrice = floor(data.data?.bp, quotePrecision);
                askPrice = floor(data.data?.ap, quotePrecision);
            }
        });

        wsSpot.subscribe(['outboundAccountInfo', `bookticker.${symbol}`]);

        ({ basePosition, quotePosition } = await getPositions());
        ({ callOption, putOption, expiry } = await getOptions());

        while (true) {
            var { result: { price: p }, retCode, retMsg } = await client.getLastTradedPrice(symbol);
            bidPrice = floor(p, quotePrecision);
            if (isNaN(bidPrice)) continue;
            if (retCode == 0) break;
            logError(`Failed getting price (${retCode}) ${retMsg}`)
        }

        let netPosition = floor(basePosition.free - basePosition.loan, basePrecision);
        if (!callOption && !putOption && Math.abs(netPosition) > 0.0001) await settleAccount(basePosition, bidPrice);

        initialEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);

        while (true) {
            await asyncSleep(100);

            currentMoment = new Date();
            if (expiryTime && currentMoment > expiryTime) {
                expiryTime = null;
                size = 0;
                strikePrice = 0;
                optionsNeedUpdate = true;
                positionsNeedUpdate = true;

                await settleAccount(basePosition, bidPrice);
                await moveFundsToSpot();
                await reconcileLoan(basePosition, size, bidPrice);
            }

            if (positionsNeedUpdate) {
                ({ basePosition, quotePosition } = await getPositions());
                positionsNeedUpdate = false;
            }

            if (optionsNeedUpdate) {
                ({ callOption, putOption, expiry } = await getOptions());
                optionsNeedUpdate = false;
            }

            if (!expiry) {
                let spotEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);
                let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
                let availiableUnified = (!coin || coin.length == 0) ? 0 : floor(coin[0].availableBalance, quotePrecision);
                let equity = spotEquity + availiableUnified;
                let tradableEquity = equity * tradeMargin;

                size = floor((tradableEquity * leverage) / ((1 + optionIM) * bidPrice), optionPrecision);

                let requiredMargin = bidPrice * size * optionIM;
                let netPosition = Math.abs(floor(basePosition.free - basePosition.loan, basePrecision));
                if (netPosition > 0.0001) await settleAccount(basePosition, bidPrice);

                await splitEquity(requiredMargin - availiableUnified);
                await placeStraddle(bidPrice, size);
                await reconcileLoan(basePosition, size, bidPrice);

                optionsNeedUpdate = true;
                positionsNeedUpdate = true;

                continue;
            }

            if (strikePrice == 0 || expiryTime == null || size == 0) {
                let option = (callOption || putOption);
                if (!option || !expiry) {
                    optionsNeedUpdate = true;
                    continue;
                }

                strikePrice = option.limit;
                size = floor(parseFloat(`${option.size || 0}`), optionPrecision);
                expiryTime = expiry;
            }

            await executeTrade({ askPrice, basePosition, bidPrice, initialEquity, size, quotePosition, strikePrice });
        }
    }
    catch (err) {
        try {
            await logError(`${err}`);
            closeWebSocket(wsSpot);
        } catch (lerr) {
            console.error(lerr);
        }
    }
}