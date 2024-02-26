export function countDecimals(value: number): number {
    if (Math.floor(value) === value) return 0;

    let str = value.toString();
    let decimals = 0;
    if (str.indexOf('e') !== -1) {
        decimals -= Number(str.split('e')[1]) || 0;
        str = str.split('e')[0];
    }
    if (str.indexOf('.') !== -1) decimals += str.split('.')[1].length || 0;
    return decimals;
}

export function countDigits(value: number): number {
    let str = value.toString();
    let decimals = 0;
    if (str.indexOf('e') !== -1) {
        decimals += Number(str.split('e')[1]) || 0;
        str = str.split('e')[0];
    }
    if (str.indexOf('.') !== -1) str = str.split('.')[0];
    decimals += str.length;
    return decimals;
}

export function roundToPrecision(value: number, precision: number, useFactorsOf10: boolean | undefined = false): number {
    if (precision === undefined || precision === null || isNaN(precision) || precision < 0) return value;

    let decimalCount = precision;
    if (useFactorsOf10) {
        decimalCount = countDecimals(precision);
        let checkNumber = Number(`1e-${decimalCount}`);
        if (precision !== checkNumber) value = value - safeMod(value, precision);
    }

    return round(value, decimalCount);
}

export function shiftDecimalRight(value: number, decimals: number): number {
    return shift(value, Math.abs(decimals));
}

export function shiftDecimalLeft(value: number, decimals: number): number {
    return shift(value, -Math.abs(decimals));
}

export function safeMod(dividend: number, divisor: number): number {
    let divisorDecimals = countDecimals(divisor);
    let dividendDecimals = countDecimals(dividend);

    let shiftedDividend = shiftDecimalRight(dividend, divisorDecimals);
    let shiftedDivisor = shiftDecimalRight(divisor, divisorDecimals);
    let shiftedRemainder = shiftedDividend % shiftedDivisor;
    let remainder = shiftDecimalLeft(shiftedRemainder, divisorDecimals);

    return round(remainder, dividendDecimals);
}

export function shift(value: number, decimals: number): number {
    let temp = value;
    let str = temp.toString();
    let exp = 0;
    if (str.indexOf('e') !== -1) {
        exp = Number(str.split('e')[1]) || 0;
        temp = Number(str.split('e')[0]) || 0;
    }

    return Number(`${temp}e${(exp + decimals)}`);
}

export function round(value: number, decimals: number): number {
    if (value === undefined || value === null || isNaN(value)) return value;

    let shifted = shiftDecimalRight(value, decimals);
    let temp = Math.round(shifted);
    let result = shiftDecimalLeft(temp, decimals);

    if (isNaN(result)) return value;
    return result;
}

export function floor(value: number, decimals: number): number {
    if (value === undefined || value === null || isNaN(value)) return value;

    let shifted = shiftDecimalRight(value, decimals);
    let temp = Math.floor(shifted);
    let result = shiftDecimalLeft(temp, decimals);

    if (isNaN(result)) return value;
    return result;
}

export function asNumber(value: any): number | undefined {
    if (value === undefined || value === null) return undefined;
    let number = Number(value);
    if (isNaN(number)) return undefined;
    return number;
}