'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

const utils = require('@iobroker/adapter-core');

const net = require('net');

const xml2js = require('xml2js');
const fs = require('fs');

const { Client } = require('ssh2');
//Hilfsobjekt zum abfragen der Werte
const datapoints = {};
let toPoll = {};
//Zähler für Hilfsobjekt
let step = -1;
//Hilfsarray zum setzen von Werten
let setcommands = [];

//helpers for timeout
let timerWait = null;
let timerErr = null;
let timerTimeout = null;
let timerReconnect = null;
let wait = false;

const client = new net.Socket();
const parser = new xml2js.Parser();

//development herlpers
const log_catch_err = false;

class Viessmann extends utils.Adapter {
    /**
     * @param [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'viessmann',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        this.startAdapter();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback
     */
    onUnload(callback) {
        try {
            this.setState('info.connection', false, true);
            client.end();
            client.destroy(); // kill client after server's response
            // Here you must clear all timeouts or intervals that may still be active
            clearTimeout(timerWait);
            clearTimeout(timerErr);
            clearTimeout(timerTimeout);
            clearTimeout(timerReconnect);
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            console.log(e);
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id
     * @param state
     */
    onStateChange(id, state) {
        if (state) {
            if (id === `${this.namespace}.input.force_polling_interval`) {
                this.log.info(`Force polling interval: ${state.val}`);
                this.force(state.val);
            } else {
                this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                setcommands.push(String(`set${id.substring(16, id.length)} ${state.val}`));
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
    //##############################################################################################
    // is called when databases are connected and adapter received configuration.
    // start here!
    async startAdapter() {
        if (!this.config.datapoints.gets) {
            this.readxml();
        } else if (this.config.new_read) {
            this.log.info(`Start read new XML...`);
            const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (!obj) {
                this.log.warn(`No instance found! ${JSON.stringify(obj)}`);
                return;
            }
            obj.native.datapoints = {};
            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj);
            this.log.info(`Try to read new XML files!`);
            this.readxml();
        } else {
            this.main();
        }
    }

    //##########IMPORT XML FILE##################################################################################

    async readxml() {
        this.log.debug('try to read xml files');
        if (this.config.ip === '127.0.0.1') {
            this.vcontrold_read(`${this.config.path}/vcontrold.xml`);
        } else {
            //Create a SSH connection
            const ssh_session = new Client();
            this.log.debug('try to create a ssh session');
            ssh_session.connect({
                host: this.config.ip,
                username: this.config.user_name,
                password: this.config.password,
            });
            ssh_session.on('ready', () => {
                this.log.debug('FTP session ready');
                ssh_session.sftp((err, sftp) => {
                    if (err) {
                        this.log.warn(`cannot create a SFTP session ${err}`);
                        this.setState('info.connection', false, true);
                        ssh_session.end();
                    } else {
                        const moveVcontroldFrom = `${this.config.path}/vcontrold.xml`;
                        const moveVcontroldTo = `${__dirname}/vcontrold.xml`;
                        const moveVitoFrom = `${this.config.path}/vito.xml`;
                        const moveVitoTo = `${__dirname}/vito.xml`;
                        this.log.debug(`Try to copy Vito from: ${moveVitoFrom} to: ${__dirname}`);
                        sftp.fastGet(moveVitoFrom, moveVitoTo, {}, err => {
                            if (err) {
                                this.log.warn(`cannot read vito.xml from Server: ${err}`);
                                this.setState('info.connection', false, true);
                                ssh_session.end();
                            }
                            this.log.debug('Copy vito.xml from server to host successfully');
                            sftp.fastGet(moveVcontroldFrom, moveVcontroldTo, {}, err => {
                                if (err) {
                                    this.log.warn(`cannot read vcontrold.xml from Server: ${err}`);
                                    this.vcontrold_read(moveVcontroldTo);
                                    ssh_session.end();
                                }
                                this.log.debug('Copy vcontrold.xml from server to host successfully');
                                this.vcontrold_read(moveVcontroldTo);
                            });
                        });
                    }
                });
            });
            ssh_session.on('close', () => {
                this.log.debug('SSH connection closed');
            });
            ssh_session.on('error', err => {
                this.log.warn(`check your SSH login dates ${err}`);
            });
        }
    }

    async vcontrold_read(path) {
        fs.readFile(path, 'utf8', (err, data) => {
            if (err) {
                this.log.warn(`cannot read vcontrold.xml ${err}`);
                this.vito_read();
            } else {
                parser.parseString(data, (err, result) => {
                    if (err) {
                        this.log.warn(`cannot parse vcontrold.xml --> cannot use units  ${err}`);
                        this.vito_read();
                    } else {
                        let temp;
                        try {
                            temp = JSON.stringify(result);
                            temp = JSON.parse(temp);
                        } catch (e) {
                            this.log.warn(`check vcontrold.xml structure:  ${e}`);
                            this.setState('info.connection', false, true);
                            this.vito_read();
                            return;
                        }
                        const units = {};
                        const types = {};
                        for (const i in temp['V-Control'].units[0].unit) {
                            try {
                                for (const e in temp['V-Control'].units[0].unit[i].entity) {
                                    this.log.debug(`Numbers of entitys ${e}`);
                                    const obj = new Object();
                                    obj.unit = temp['V-Control'].units[0].unit[i].entity[0];
                                    units[temp['V-Control'].units[0].unit[i].abbrev[0]] = obj;
                                }
                            } catch (e) {
                                this.log.warn(`check vcontrold.xml structure cannot read units:  ${e}`);
                            }
                            try {
                                for (const e in temp['V-Control'].units[0].unit[i].type) {
                                    this.log.debug(`Numbers of types ${e}`);
                                    const obj = new Object();
                                    obj.type = temp['V-Control'].units[0].unit[i].type[0];
                                    types[temp['V-Control'].units[0].unit[i].abbrev[0]] = obj;
                                }
                            } catch (e) {
                                this.log.warn(`check vcontrold.xml structure cannot read types:  ${e}`);
                            }
                        }
                        this.log.debug(`Types in vcontrold.xml: ${JSON.stringify(types)}`);
                        this.log.debug(`Units in vcontrold.xml: ${JSON.stringify(units)}`);
                        this.log.info('read vcontrold.xml successfull');
                        this.vito_read(units, types);
                    }
                });
            }
        });
    }

    async vito_read(units, types) {
        const path_ssh = `${__dirname}/vito.xml`;
        const path_host = `${this.config.path}/vito.xml`;
        let path = '';
        if (this.config.ip === '127.0.0.1') {
            path = path_host;
        } else {
            path = path_ssh;
        }
        fs.readFile(path, 'utf8', (err, data) => {
            if (err) {
                this.log.warn(`cannot read vito.xml ${err}`);
                this.setState('info.connection', false, true);
            } else {
                parser.parseString(data, async (err, result) => {
                    if (err) {
                        this.log.warn(`cannot parse vito.xml ${err}`);
                        this.setState('info.connection', false, true);
                    } else {
                        try {
                            let temp = JSON.stringify(result);
                            temp = JSON.parse(temp);
                            const dp = await this.getImport(temp, units, types);
                            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                                native: { datapoints: dp, new_read: false },
                            });
                            this.log.info('read vito.xml successfull');
                            this.main();
                        } catch (e) {
                            this.log.warn(`check vito.xml structure ${e}`);
                            this.setState('info.connection', false, true);
                        }
                    }
                });
            }
        });
    }
    //###########################################################################################################

    //######IMPORT STATES########################################################################################
    async getImport(json, units, types) {
        datapoints['gets'] = {};
        datapoints['sets'] = {};
        datapoints['system'] = {};
        if (typeof json.vito.commands[0].command === 'object') {
            datapoints.system['-ID'] = json.vito.devices[0].device[0].$.ID;
            datapoints.system['-name'] = json.vito.devices[0].device[0].$.name;
            datapoints.system['-protocol'] = json.vito.devices[0].device[0].$.protocol;

            for (const i in json.vito.commands[0].command) {
                const poll = -1;
                const get_command = json.vito.commands[0].command[i].$.name;
                const desc = json.vito.commands[0].command[i].description[0];
                if (get_command.substring(0, 3) === 'get' && get_command.length > 3) {
                    const obj_get = new Object();
                    obj_get.name = get_command.substring(3, get_command.length);
                    try {
                        obj_get.unit = units[json.vito.commands[0].command[i].unit[0]].unit;
                    } catch (e) {
                        if (log_catch_err) {
                            this.log.error(e);
                        }
                        this.log.error(e);
                        obj_get.unit = '';
                    }
                    try {
                        obj_get.type = this.get_type(types[json.vito.commands[0].command[i].unit[0]].type);
                    } catch (e) {
                        if (log_catch_err) {
                            this.log.error(e);
                        }
                        this.log.error(e);
                        obj_get.type = 'mixed';
                    }
                    obj_get.description = desc;
                    obj_get.polling = poll;
                    obj_get.command = get_command;
                    datapoints.gets[get_command.substring(3, get_command.length)] = obj_get;
                    continue;
                }
                if (get_command.substring(0, 3) === 'set' && get_command.length > 3) {
                    const obj_set = new Object();
                    obj_set.name = get_command.substring(3, get_command.length);
                    obj_set.description = desc;
                    obj_set.polling = 'nicht möglich';
                    try {
                        obj_set.type = this.get_type(types[json.vito.commands[0].command[i].unit[0]].type);
                    } catch (e) {
                        if (log_catch_err) {
                            this.log.error(e);
                        }
                        this.log.error(e);
                        obj_set.type = 'mixed';
                    }
                    obj_set.command = get_command;
                    datapoints.sets[get_command.substring(3, get_command.length)] = obj_set;
                    continue;
                }
            }
            this.log.debug(`Objects are: ${JSON.stringify(datapoints)}`);
            return datapoints;
        }
    }
    //###########################################################################################################

    //######GET TYPES########################################################################################
    get_type(types) {
        switch (types) {
            case 'enum':
                return 'string';
                // eslint-disable-next-line no-unreachable
                break;
            case 'systime':
                return 'string';
                // eslint-disable-next-line no-unreachable
                break;
            case 'cycletime':
                return 'string';
                // eslint-disable-next-line no-unreachable
                break;
            case 'errstate':
                return 'string';
                // eslint-disable-next-line no-unreachable
                break;
            case 'char':
                return 'number';
                // eslint-disable-next-line no-unreachable
                break;
            case 'uchar':
                return 'number';
                // eslint-disable-next-line no-unreachable
                break;
            case 'int':
                return 'number';
                // eslint-disable-next-line no-unreachable
                break;
            case 'uint':
                return 'number';
                // eslint-disable-next-line no-unreachable
                break;
            case 'short':
                return 'number';
                // eslint-disable-next-line no-unreachable
                break;
            case 'ushort':
                return 'number';
                // eslint-disable-next-line no-unreachable
                break;
            default:
                return 'mixed';
        }
    }
    //###########################################################################################################

    //######SET STATES###########################################################################################
    async addState(pfad, name, unit, beschreibung, type, write, callback) {
        await this.setObjectNotExistsAsync(
            pfad + name,
            {
                type: 'state',
                common: {
                    name: name,
                    unit: unit,
                    type: type,
                    desc: beschreibung,
                    read: true,
                    write: write,
                },
                native: {},
            },
            callback,
        );
    }
    //###########################################################################################################

    //######CONFIG STATES########################################################################################
    setAllObjects(callback) {
        this.getStatesOf((err, states) => {
            const configToDelete = [];
            const configToAdd = [];
            //let id;
            const pfadget = 'get.';
            const pfadset = 'set.';
            let count = 0;

            if (this.config.datapoints) {
                if (this.config.states_only) {
                    for (const i in this.config.datapoints.gets) {
                        if (
                            this.config.datapoints.gets[i].polling !== -1 &&
                            this.config.datapoints.gets[i].polling != '-1'
                        ) {
                            configToAdd.push(this.config.datapoints.gets[i].name);
                        }
                    }
                } else {
                    for (const i in this.config.datapoints.gets) {
                        configToAdd.push(this.config.datapoints.gets[i].name);
                    }
                }
                for (const i in this.config.datapoints.sets) {
                    configToAdd.push(this.config.datapoints.sets[i].name);
                }
            }
            if (states) {
                for (let i = 0; i < states.length; i++) {
                    const name = states[i].common.name;
                    if (
                        typeof name == 'object' ||
                        name === 'connection' ||
                        name === 'lastPoll' ||
                        name === 'timeout_connection' ||
                        name === 'Force polling interval'
                    ) {
                        continue;
                    }
                    const clean = states[i]._id;
                    if (name.length < 1) {
                        this.log.warn(`No states found for ${JSON.stringify(states[i])}`);
                        continue;
                    }

                    //id = name.replace(/[.\s]+/g, '_');
                    const pos = configToAdd.indexOf(name);
                    if (pos !== -1) {
                        configToAdd.splice(pos, 1);
                    } else {
                        configToDelete.push(clean);
                    }
                }
            }
            if (configToAdd.length) {
                for (const i in this.config.datapoints.gets) {
                    if (configToAdd.indexOf(this.config.datapoints.gets[i].name) !== -1) {
                        count++;
                        this.addState(
                            pfadget,
                            this.config.datapoints.gets[i].name,
                            this.config.datapoints.gets[i].unit,
                            this.config.datapoints.gets[i].description,
                            this.config.datapoints.gets[i].type,
                            false,
                            () => {
                                if (!--count && callback) {
                                    callback();
                                }
                            },
                        );
                    }
                }
                for (const i in this.config.datapoints.sets) {
                    if (configToAdd.indexOf(this.config.datapoints.sets[i].name) !== -1) {
                        count++;
                        this.addState(
                            pfadset,
                            this.config.datapoints.sets[i].name,
                            '',
                            this.config.datapoints.sets[i].description,
                            this.config.datapoints.sets[i].type,
                            true,
                            () => {
                                if (!--count && callback) {
                                    callback();
                                }
                            },
                        );
                    }
                }
            }
            if (configToDelete.length) {
                for (let e = 0; e < configToDelete.length; e++) {
                    this.log.debug(`States to delete: ${configToDelete[e]}`);
                    this.delObject(configToDelete[e]);
                }
            }
            if (!count && callback) {
                callback();
            }
        });
    }
    //###########################################################################################################

    //######POLLING##############################################################################################
    stepPolling() {
        if (wait) {
            this.log.warn(`Wait for feedback from Vcontrold...`);
            return;
        }
        clearTimeout(timerWait);
        step = -1;
        let actualMinWaitTime = 1000000;
        const time = Date.now();

        if (setcommands.length > 0) {
            const cmd = setcommands.shift();
            this.log.debug(`Set command: ${cmd}`);
            client.write(`${cmd}\n`);
            return;
        }

        for (const i in toPoll) {
            if (typeof toPoll[i].lastPoll === 'undefined') {
                toPoll[i].lastPoll = time;
            }
            const nextRun = toPoll[i].lastPoll + toPoll[i].polling * 1000;
            const nextDiff = nextRun - time;

            if (time < nextRun) {
                if (actualMinWaitTime > nextDiff) {
                    actualMinWaitTime = nextDiff;
                }
                continue;
            }

            if (nextDiff < actualMinWaitTime) {
                actualMinWaitTime = nextDiff;

                step = i;
            }
        }

        if (step == Object.keys(toPoll)[Object.keys(toPoll).length - 1] || step === -1) {
            this.setState('info.lastPoll', Math.floor(time / 1000), true);
        }
        if (step === -1) {
            this.log.debug(`Wait for next run: ${actualMinWaitTime} in ms`);
            timerWait = setTimeout(() => {
                this.stepPolling();
            }, actualMinWaitTime);
        } else {
            this.log.debug(`Next poll: ${toPoll[step].command}  (For Object: ${step})`);
            toPoll[step].lastPoll = Date.now();
            client.write(`${toPoll[step].command}\n`);
            wait = true;
        }
    }
    //###########################################################################################################

    //######CONFIGURE POLLING COMMANDS###########################################################################
    commands() {
        let obj = new Object();
        obj.name = 'Dummy';
        obj.command = 'heartbeat';
        obj.description = 'keep the adapter to stay alive';
        obj.polling = 60;
        obj.lastpoll = 0;
        toPoll['heartbeat'] = obj;

        for (const i in this.config.datapoints.gets) {
            if (this.config.datapoints.gets[i].polling > -1) {
                this.log.debug(`Commands for polling: ${this.config.datapoints.gets[i].command}`);
                obj = new Object();
                obj.name = this.config.datapoints.gets[i].name;
                obj.command = this.config.datapoints.gets[i].command;
                obj.description = this.config.datapoints.gets[i].description;
                obj.polling = this.config.datapoints.gets[i].polling;
                obj.lastpoll = 0;
                toPoll[i] = obj;
            }
        }
    }
    //###########################################################################################################

    //######CUT ANSWER###########################################################################################
    split_unit(v) {
        // test if string starts with non digits, then just pass it
        if (typeof v === 'string' && v !== '' && /^\D.*$/.test(v) && !/^-?/.test(v)) {
            return v;
        } else if (typeof v === 'string' && v !== '') {
            const split = v.match(/^([-.\d]+(?:\.\d+)?)(.*)$/);
            if (this.isDate(split[1])) {
                return v;
            }
            return split[1].trim();
        }
        // catch the rest

        return v;
    }

    isDate(val) {
        const d = new Date(val);
        return !isNaN(d.valueOf());
    }

    roundNumber(num, scale) {
        const number = Math.round(num * Math.pow(10, scale)) / Math.pow(10, scale);
        if (num - number > 0) {
            return (
                number +
                Math.floor((2 * Math.round((num - number) * Math.pow(10, scale + 1))) / 10) / Math.pow(10, scale)
            );
        }

        return number;
    }

    connectSystem() {
        const ip = this.config.ip;
        const port = this.config.port || 3002;
        const time_out = 120000;

        this.log.info(`Connecting...`);
        client.setTimeout(time_out);
        client.connect(port, ip);
        wait = false;
    }
    //###########################################################################################################

    //######MAIN#################################################################################################
    async main() {
        this.setState('info.timeout_connection', false, true);
        this.setState('info.connection', false, true);

        toPoll = {};
        setcommands = [];

        const answer = this.config.answer;
        const time_reconnect = this.config.reconnect;
        let time_reconnect_type = Number(time_reconnect);
        time_reconnect_type = typeof time_reconnect_type;

        let err_count = 0;

        clearTimeout(timerErr);
        clearTimeout(timerReconnect);
        this.setAllObjects();

        this.connectSystem();

        client.on('close', () => {
            this.setState('info.connection', false, true, err => {
                if (err) {
                    this.log.error(err);
                }
            });
            this.log.info('Disconnected with Viessmann system!');
            client.destroy();
        });

        client.on('ready', () => {
            this.setState('info.connection', true, true, err => {
                if (err) {
                    this.log.error(err);
                }
            });
            this.log.info('Connect with Viessmann sytem!');
            this.setState('info.timeout_connection', false, true);
            this.commands();
            this.stepPolling();
        });

        client.on('data', data => {
            data = String(data);
            const ok = /OK/;
            const fail = /ERR/;
            const vctrld = /vctrld>/;

            if (ok.test(data)) {
                this.log.debug('Send command okay!');
                wait = false;
                this.stepPolling();
            } else if (fail.test(data) && step !== 'heartbeat') {
                this.log.warn(`Vctrld send ERROR: ${data}`);
                err_count++;
                if (err_count > 5 && this.config.errors) {
                    this.setState('info.connection', false, true);
                    this.log.warn('Vctrld send too many errors, restart connection!');
                    //client.end();
                    client.destroy();
                    clearTimeout(timerWait);
                    timerWait = null;
                    timerErr = setTimeout(() => {
                        this.clearTimeout(timerErr);
                        timerErr = null;
                        this.log.info(`Try to reconnect...`);
                        this.connectSystem();
                    }, 10000);
                } else {
                    wait = false;
                    this.stepPolling();
                }
            } else if (data == 'vctrld>') {
                return;
            } else if (step == -1) {
                return;
            } else if (step == 'heartbeat') {
                wait = false;
                this.stepPolling();
            } else if (step == '') {
                return;
            } else {
                wait = false;
                this.log.debug(`Received: ${data}`);
                err_count = 0;
                if (vctrld.test(data)) {
                    data = data.substring(0, data.length - 7);
                }
                try {
                    data = data.replace(/\n$/, '');
                    if (answer) {
                        data = this.split_unit(data);
                        if (!isNaN(data)) {
                            data = this.roundNumber(parseFloat(data), 2);
                        }
                        this.setState(`get.${toPoll[step].name}`, data, true, err => {
                            if (err) {
                                this.log.error(err);
                            }
                            this.stepPolling();
                        });
                    } else {
                        this.setState(`get.${toPoll[step].name}`, data, true, err => {
                            if (err) {
                                this.log.error(err);
                            }
                            this.stepPolling();
                        });
                    }
                } catch (e) {
                    if (log_catch_err) {
                        this.log.error(e);
                    }
                    this.setState(`get.${toPoll[step].name}`, data, true, err => {
                        if (err) {
                            this.log.error(err);
                        }
                        this.stepPolling();
                    });
                }
                err_count = 0;
            }
        });
        client.on('error', e => {
            this.setState('info.connection', false, true);
            this.log.warn(`Connection error--> ${e}`);
            //client.end();
            client.destroy(); // kill client after server's response
            if (timerReconnect) {
                clearTimeout(timerReconnect);
                timerReconnect = null;
            }
            if (time_reconnect != '' && time_reconnect_type == 'number') {
                timerReconnect = setTimeout(() => {
                    this.log.info(`Try to reconnect...`);
                    this.connectSystem();
                }, time_reconnect * 60000);
            } else {
                this.log.warn('Reconnect time is wrong');
            }
        });
        client.on('timeout', () => {
            this.setState('info.connection', false, true);
            this.log.warn('Timeout connection error!');
            this.setState('info.timeout_connection', true, true);
            //client.end();
            client.destroy(); // kill client after server's response
            clearTimeout(timerWait);
            timerWait = null;
            if (timerTimeout) {
                clearTimeout(timerTimeout);
                timerTimeout = null;
            }
            if (time_reconnect != '' && time_reconnect_type == 'number') {
                timerReconnect = setTimeout(() => {
                    this.log.info(`Try to reconnect...`);
                    this.connectSystem();
                }, time_reconnect * 60000);
            } else {
                this.log.warn('Reconnect time is wrong');
            }
        });

        // in this viessmann all states changes inside the adapters namespace are subscribed

        this.subscribeStates('set.*');
        this.subscribeStates('input.*');
    }
    //#############HELPERS#######################################################################################
    force(id) {
        try {
            const force_step = id.slice(3);
            toPoll[force_step].lastPoll = 0;
            this.stepPolling();
        } catch (e) {
            this.log.debug(e);
            this.log.warn(`Force polling interval: ${id} not incude in get states`);
        }
    }

    //###########################################################################################################
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param [options]
     */
    module.exports = options => new Viessmann(options);
} else {
    // otherwise start the instance directly
    new Viessmann();
}
