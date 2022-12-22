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
    sidewaysLimit: number = 0,
    optionIM: number = 0,
    logFrequency: number = 0,
    targetROI: number = 0,
    optionROI: number = 0,
    useTestnet: boolean = false,
    leverage: number = 0;

let
    spotStrikePrice: number = 0,
    initialEquity: number = 0,
    targetProfit: number = 0,
    sideWaysCount: number = 0,
    quantity: number = 0,
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
    bidBelowStrike: boolean = false,
    askAboveStrike: boolean = false,
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
    return qouteTotal + baseTotal;
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
    let lowerLimit = (price % optionInterval) < halfInterval ? contractPrice - optionInterval : contractPrice;
    let upperLimit = lowerLimit + (optionInterval * 2);

    let expiryTime = new Date();
    expiryTime.setUTCDate(expiryTime.getUTCDate() + ((expiryTime.getUTCHours() < 8) ? 0 : 1));
    expiryTime.setUTCHours(8);
    expiryTime.setUTCMinutes(0);
    expiryTime.setUTCSeconds(0);
    expiryTime.setUTCMilliseconds(0);

    let yearStr = `${expiryTime.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);

    let putSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${lowerLimit}-P`;
    let callSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${upperLimit}-C`;
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

function calculateState({
    spotStrikePrice,
    initialEquity,
    targetProfit,
    quantity,
    basePosition,
    quotePosition,
    callOption,
    putOption,
    price
}: {
    spotStrikePrice: number,
    initialEquity: number,
    targetProfit: number,
    quantity: number,
    basePosition: Position,
    quotePosition: Position,
    putOption: OptionPosition | null,
    callOption: OptionPosition | null,
    price: number
}): {
    spotStrikePrice: number,
    initialEquity: number,
    targetProfit: number,
    quantity: number
} {
    if (spotStrikePrice == 0) spotStrikePrice = price;
    if (initialEquity == 0 && !callOption && !putOption) {
        initialEquity = calculateNetEquity(basePosition, quotePosition, price);
        let tradableEquity = initialEquity * tradeMargin;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = floor((tradableEquity * leverage) / price, basePrecision);
    }
    if (initialEquity == 0 && (callOption || putOption)) {
        initialEquity = calculateNetEquity(basePosition, quotePosition, price);
        let option = callOption || putOption;
        quantity = Math.abs(parseFloat(`${option?.size}`));
        let tradableEquity = (price * quantity * (1 + optionIM)) / leverage;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
    }
    return { spotStrikePrice, initialEquity, targetProfit, quantity };
}

async function getOptionMarkPrice(symbol: string): Promise<number> {
    let { result, retCode, retMsg } = await unifiedClient.getSymbolTicker('option', symbol);
    if (retCode != 0) {
        logError(retMsg);
        return 0;
    }
    let price = floor(result.markPrice, quotePrecision);
    return price;
}

async function executeTrade({
    expiry,
    expiryTime,
    putOption,
    callOption,
    spotStrikePrice,
    initialEquity,
    basePosition,
    quotePosition,
    targetProfit,
    quantity,
    sideWaysCount,
    askPrice,
    bidPrice,
    bidBelowStrike,
    askAboveStrike
}: {
    expiry: Date | null,
    expiryTime: Date | null,
    putOption: OptionPosition | null,
    callOption: OptionPosition | null,
    spotStrikePrice: number,
    initialEquity: number,
    basePosition: Position,
    quotePosition: Position,
    targetProfit: number,
    quantity: number,
    sideWaysCount: number,
    askPrice: number,
    bidPrice: number,
    bidBelowStrike: boolean,
    askAboveStrike: boolean
}): Promise<{
    expiryTime: Date | null,
    spotStrikePrice: number,
    initialEquity: number,
    targetProfit: number,
    quantity: number,
    sideWaysCount: number,
    bidBelowStrike: boolean,
    askAboveStrike: boolean
}> {
    if (expiryTime == null) expiryTime = expiry;
    let lowerLimit = putOption?.limit || 0;
    let upperLimit = callOption?.limit || 0;
    if (lowerLimit == 0 && upperLimit > 0) lowerLimit = upperLimit - (optionInterval * 2);
    if (upperLimit == 0 && lowerLimit > 0) upperLimit = lowerLimit + (optionInterval * 2);
    if (bidPrice == 0) bidPrice = askPrice;

    let netEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);
    let profit = netEquity - initialEquity - targetProfit;
    let netPosition = floor(basePosition.free - basePosition.loan, basePrecision);

    if ((logCount % logFrequency) == 0) {
        log(`f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} e:${expiryTime?.toISOString()} u:${upperLimit} l:${lowerLimit} c:${callOption?.unrealisedPnl} p:${putOption?.unrealisedPnl}`);
        logCount = 1;
    }
    else logCount++;

    let deltaProfit = Math.abs((spotStrikePrice * quantity) - (bidPrice * quantity)) - profit;
    if (sideWaysCount > sidewaysLimit && deltaProfit > 0 && !expiryTime) {
        log(`Sideways breakout d:${deltaProfit} f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} `);
        return { expiryTime, spotStrikePrice: bidPrice, initialEquity, targetProfit, quantity, sideWaysCount: 0, askAboveStrike, bidBelowStrike };
    }

    if (sideWaysCount > sidewaysLimit && !expiryTime) {
        let { callSymbol, putSymbol } = getOptionSymbols(askPrice);

        let spotEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);
        let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
        let availiableUnified = (!coin || coin.length == 0) ? 0 : floor(coin[0].availableBalance, quotePrecision);
        let equity = (spotEquity + availiableUnified)
        let tradableEquity = equity * tradeMargin;

        quantity = floor((tradableEquity * leverage) / ((1 + optionIM) * bidPrice), optionPrecision);
        targetProfit = floor(tradableEquity * optionROI, quotePrecision);

        let requiredMargin = bidPrice * quantity * optionIM;
        let callPrice = await getOptionMarkPrice(callSymbol);
        let putPrice = await getOptionMarkPrice(putSymbol);

        let optionProfit = netEquity - initialEquity - targetProfit + (callPrice * quantity) + (putPrice * quantity);

        if ((logCount % logFrequency) == 0) {
            log(`Trading Sideways ${sideWaysCount} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} op:${optionProfit} c(${callSymbol}):${callPrice} p(${putSymbol}):${bidPrice}`);
        }

        if (basePosition.free != basePosition.loan) await settleAccount(basePosition, bidPrice);

        if (optionProfit < 0) return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
        log(`placing straddle ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} op:${optionProfit} c(${callSymbol}):${callPrice} p(${putSymbol}):${putPrice}`);

        await splitEquity(requiredMargin - availiableUnified);
        expiryTime = await placeStraddle(bidPrice, quantity);
        await reconcileLoan(basePosition, quantity, bidPrice);

        askAboveStrike = false;
        bidBelowStrike = false;
        positionsNeedUpdate = true;
        optionsNeedUpdate = true;
        spotStrikePrice = 0;
        sideWaysCount = 0;

        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }

    if (expiryTime && !callOption && !putOption && netPosition != 0) {
        await settleAccount(basePosition, askPrice);
        await moveFundsToSpot();

        spotStrikePrice = 0;
        initialEquity = 0;
        sideWaysCount = 0;
        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }
    if (expiryTime && !callOption && !putOption) return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };

    if (askAboveStrike && askPrice < spotStrikePrice) askAboveStrike = false;

    if (bidBelowStrike && bidPrice > spotStrikePrice) bidBelowStrike = false;

    if (bidBelowStrike || askAboveStrike) return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };

    if ((callOption || putOption) &&
        netPosition != 0 &&
        bidPrice < upperLimit &&
        askPrice > lowerLimit &&
        sideWaysCount < sidewaysLimit) {
        log(`outofthemoney f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} e:${expiryTime?.toISOString()} u:${upperLimit} l:${lowerLimit} c:${callOption?.unrealisedPnl} p:${putOption?.unrealisedPnl}`);
        await settleAccount(basePosition, askPrice);
        if (askPrice > upperLimit) {
            spotStrikePrice = upperLimit;
            askAboveStrike = true;
        }
        if (bidPrice < lowerLimit) {
            spotStrikePrice = lowerLimit;
            bidBelowStrike = true;
        }
        sideWaysCount++;
        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }

    if (putOption && bidPrice < lowerLimit && basePosition.free > 0) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(lowerLimit * (1 - slippage), quotePrecision);
        spotStrikePrice = lowerLimit;
        askAboveStrike = true;
        log(`put lower f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} e:${expiryTime?.toISOString()} u:${upperLimit} l:${lowerLimit} c:${callOption?.unrealisedPnl} p:${putOption?.unrealisedPnl}`);
        await immediateSell(symbol, sellAmount, sellPrice);
        sideWaysCount++;
        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }

    let longAmount = floor(quantity - netPosition, basePrecision);
    if (callOption && askPrice > upperLimit && longAmount > 0) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(upperLimit * (1 + slippage), quotePrecision);
        spotStrikePrice = upperLimit;
        bidBelowStrike = true;
        log(`call upper f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} e:${expiryTime?.toISOString()} u:${upperLimit} l:${lowerLimit} c:${callOption?.unrealisedPnl} p:${putOption?.unrealisedPnl}`);
        await immediateBuy(symbol, buyAmount, buyPrice);
        sideWaysCount++;
        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }

    if (callOption || putOption) return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };

    if (profit > 0) {
        log(`take profit f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} `);
        await settleAccount(basePosition, askPrice);
        await moveFundsToSpot();
        askAboveStrike = false;
        bidBelowStrike = false;
        spotStrikePrice = 0;
        initialEquity = 0;
        targetProfit = 0;
        sideWaysCount = 0;
        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }

    if ((askPrice > spotStrikePrice) && (longAmount > 0)) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(askPrice * (1 + slippage), quotePrecision);
        bidBelowStrike = true;
        log(`ask upper f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} `);
        await immediateBuy(symbol, buyAmount, buyPrice);
        sideWaysCount++;
        return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
    }

    if ((bidPrice < spotStrikePrice) && (basePosition.free > 0)) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(bidPrice * (1 - slippage), quotePrecision);
        askAboveStrike = true;
        log(`bid lower f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} ab:${askAboveStrike} bp:${bidPrice} bb:${bidBelowStrike} q:${quantity} sp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} `);
        await immediateSell(symbol, sellAmount, sellPrice);
        sideWaysCount++;
    }
    return { expiryTime, spotStrikePrice, initialEquity, targetProfit, quantity, sideWaysCount, askAboveStrike, bidBelowStrike };
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
    sidewaysLimit, optionIM, logFrequency, targetROI, useTestnet,
    optionROI
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
            askPrice = floor(p, quotePrecision);
            if (isNaN(askPrice)) continue;
            if (retCode == 0) break;
            logError(`Failed getting price (${retCode}) ${retMsg}`)
        }

        ({ initialEquity, quantity, spotStrikePrice, targetProfit } = calculateState({ spotStrikePrice, targetProfit, basePosition, callOption, initialEquity, price: askPrice, putOption, quantity, quotePosition }));

        await reconcileLoan(basePosition, quantity, askPrice);

        while (true) {
            await asyncSleep(100);

            currentMoment = new Date();
            if (expiryTime && currentMoment > expiryTime) {
                spotStrikePrice = 0;
                initialEquity = 0;
                targetProfit = 0;
                sideWaysCount = 0;
                expiryTime = null;
                optionsNeedUpdate = true;
                positionsNeedUpdate = true;

                await settleAccount(basePosition, askPrice);
                await moveFundsToSpot();
                ({ initialEquity, quantity, spotStrikePrice, targetProfit } = calculateState({ spotStrikePrice, targetProfit, basePosition, callOption: null, initialEquity, price: askPrice, putOption: null, quantity, quotePosition }));

                await reconcileLoan(basePosition, quantity, askPrice);
            }

            if (positionsNeedUpdate) {
                ({ basePosition, quotePosition } = await getPositions());
                positionsNeedUpdate = false;
            }

            if (optionsNeedUpdate) {
                ({ callOption, putOption, expiry } = await getOptions());
                optionsNeedUpdate = false;
            }

            ({ initialEquity, quantity, spotStrikePrice, targetProfit } = calculateState({ spotStrikePrice, targetProfit, basePosition, callOption, initialEquity, price: askPrice, putOption, quantity, quotePosition }));

            ({ expiryTime, initialEquity, quantity, sideWaysCount, spotStrikePrice, targetProfit, askAboveStrike, bidBelowStrike } = await executeTrade({ basePosition, callOption, expiry, expiryTime, initialEquity, askPrice, bidPrice, askAboveStrike, bidBelowStrike, putOption, quantity, quotePosition, sideWaysCount, spotStrikePrice, targetProfit }));

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