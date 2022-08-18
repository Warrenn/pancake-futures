const { setTimeout: asyncSleep } = await import('timers/promises');
//process.stdin.resume();
process.stdin.on('data', process.exit.bind(process, 0));

console.log('here');
while (true) {
    await asyncSleep(3000);
    console.log('has a snooze');
}