'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

const utils = require('@iobroker/adapter-core');

const net = require('net');

const xml2js = require('xml2js');
const fs = require('fs');

const { Client } = require('ssh2');
let toPoll = {};
//Zähler für Hilfsobjekt
let step = -1;
//Hilfsarray zum setzen von Werten
let setcommands = [];

//helpers for timeout
let timerWait = null;
let timerReconnect = null;
let wait = false;

const client = new net.Socket();
const parser = new xml2js.Parser();

//development herlpers
const log_catch_err = false;

class Viessmann extends utils.Adapter {
    /**
     * @param [options] options for the adapter
     */
    constructor(options) {
        super({
            ...options,
            name: 'viessmann',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.ready = false;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        this.startAdapter();
        this.ready = true;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback callback to execute when done
     */
    onUnload(callback) {
        try {
            this.ready = false;
            this.setState('info.connection', false, true);
            client.end();
            client.destroy(); // kill client after server's response
            // Here you must clear all timeouts or intervals that may still be active
            clearTimeout(timerWait);
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
     * @param id id of the state
     * @param state state object
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
        if (this.config.datapoints && Object.keys(this.config.datapoints).length > 0) {
            this.log.info('Old configuration format found. Migrating to new format...');
            const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (obj && obj.native) {
                if (this.config.datapoints.gets) {
                    obj.native.gets = Object.values(this.config.datapoints.gets);
                    this.config.gets = obj.native.gets;
                }
                if (this.config.datapoints.sets) {
                    obj.native.sets = Object.values(this.config.datapoints.sets);
                    this.config.sets = obj.native.sets;
                }
                if (this.config.datapoints.system) {
                    obj.native.system_ID =
                        this.config.datapoints.system['-ID'] || this.config.datapoints.system.ID || '';
                    obj.native.system_name =
                        this.config.datapoints.system['-name'] || this.config.datapoints.system.name || '';
                    obj.native.system_protocol =
                        this.config.datapoints.system['-protocol'] || this.config.datapoints.system.protocol || '';
                }
                delete obj.native.datapoints;
                await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj);
                this.log.info('Migration completed successfully.');
            }
        }

        if (!this.config.gets || this.config.gets.length === 0) {
            this.readxml();
        } else if (this.config.new_read) {
            this.log.info(`Start read new XML...`);
            const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (!obj) {
                this.log.warn(`No instance found! ${JSON.stringify(obj)}`);
                return;
            }
            if (obj.native.datapoints) {
                delete obj.native.datapoints;
            }
            obj.native.gets = [];
            obj.native.sets = [];
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
                        return;
                    }
                    const moveVcontroldFrom = `${this.config.path}/vcontrold.xml`;
                    const moveVcontroldTo = `${__dirname}/vcontrold.xml`;
                    const moveVitoFrom = `${this.config.path}/vito.xml`;
                    const moveVitoTo = `${__dirname}/vito.xml`;
                    this.log.debug(`Try to copy Vito from: ${moveVitoFrom} to: ${__dirname}`);
                    sftp.fastGet(moveVitoFrom, moveVitoTo, {}, err => {
                        if (err) {
                            this.log.warn(`cannot read vito.xml from Server: ${err}`);
                            this.setState('info.connection', false, true);
                        } else {
                            this.log.debug('Copy vito.xml from server to host successfully');
                        }
                        sftp.fastGet(moveVcontroldFrom, moveVcontroldTo, {}, err => {
                            if (err) {
                                this.log.warn(`cannot read vcontrold.xml from Server: ${err}`);
                            } else {
                                this.log.debug('Copy vcontrold.xml from server to host successfully');
                            }
                            this.vcontrold_read(moveVcontroldTo);
                            ssh_session.end();
                        });
                    });
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
                            this.vito_read();
                            return;
                        }

                        const units = {};
                        const types = {};

                        try {
                            // Support both V-Control and v-control
                            const root = temp['V-Control'] || temp['v-control'];
                            if (root && root.units && root.units[0] && root.units[0].unit) {
                                for (const i in root.units[0].unit) {
                                    const unit_raw = root.units[0].unit[i];
                                    const abbrev = unit_raw.abbrev && unit_raw.abbrev[0];
                                    if (!abbrev) {
                                        continue;
                                    }

                                    if (unit_raw.entity) {
                                        units[abbrev] = { unit: unit_raw.entity[0] };
                                    }
                                    if (unit_raw.type) {
                                        types[abbrev] = { type: unit_raw.type[0] };
                                    }
                                }
                            } else {
                                this.log.warn('No units found in vcontrold.xml');
                            }
                        } catch (e) {
                            this.log.warn(`Error parsing units from vcontrold.xml: ${e}`);
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
                            const dp = await this.getImport(temp, units, types, this.config);
                            const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                            if (obj) {
                                obj.native.gets = dp.gets;
                                obj.native.sets = dp.sets;
                                obj.native.system_ID = dp.system.ID;
                                obj.native.system_name = dp.system.name;
                                obj.native.system_protocol = dp.system.protocol;
                                obj.native.new_read = false;
                                await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj);
                            }
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
    async getImport(json, units, types, oldDatapoints = null) {
        const dp = {
            gets: [],
            sets: [],
            system: {},
        };

        const vitoRoot = json.vito || json.Vito || json['v-control'] || json['V-Control'];

        if (!vitoRoot) {
            this.log.warn('No vito element found in XML');
            return dp;
        }

        try {
            if (
                vitoRoot.devices &&
                vitoRoot.devices[0] &&
                vitoRoot.devices[0].device &&
                vitoRoot.devices[0].device[0]
            ) {
                const device = vitoRoot.devices[0].device[0];
                dp.system['ID'] = device.$ ? device.$.ID : '';
                dp.system['name'] = device.$ ? device.$.name : '';
                dp.system['protocol'] = device.$ ? device.$.protocol : '';
            }
        } catch (e) {
            this.log.warn(`Error reading device info: ${e}`);
        }

        if (
            vitoRoot.commands &&
            vitoRoot.commands[0] &&
            vitoRoot.commands[0].command &&
            Array.isArray(vitoRoot.commands[0].command)
        ) {
            for (const i in vitoRoot.commands[0].command) {
                const cmd_raw = vitoRoot.commands[0].command[i];
                if (!cmd_raw.$ || !cmd_raw.$.name) {
                    continue;
                }

                const get_command = cmd_raw.$.name;
                const desc =
                    (cmd_raw.$ && cmd_raw.$.description) || (cmd_raw.description && cmd_raw.description[0]) || '';

                if (get_command.substring(0, 3) === 'get' && get_command.length > 3) {
                    let oldPolling = -1;
                    if (oldDatapoints && oldDatapoints.gets) {
                        if (Array.isArray(oldDatapoints.gets)) {
                            const oldItem = oldDatapoints.gets.find(
                                g => g.command === get_command || g.name === get_command.substring(3),
                            );
                            if (oldItem && oldItem.polling !== undefined) {
                                oldPolling = oldItem.polling;
                            }
                        } else {
                            const oldItem = oldDatapoints.gets[get_command.substring(3)];
                            if (oldItem && oldItem.polling !== undefined) {
                                oldPolling = oldItem.polling;
                            }
                        }
                    }

                    const obj_get = {
                        name: get_command.substring(3),
                        description: desc,
                        polling: oldPolling,
                        command: get_command,
                        unit: '',
                        type: 'mixed',
                    };

                    try {
                        const unit_key = cmd_raw.unit && cmd_raw.unit[0];
                        if (unit_key && units && units[unit_key]) {
                            obj_get.unit = units[unit_key].unit;
                        }
                    } catch (e) {
                        this.log.debug(`Could not read unit for ${get_command}: ${e}`);
                    }

                    try {
                        const unit_key = cmd_raw.unit && cmd_raw.unit[0];
                        if (unit_key && types && types[unit_key]) {
                            obj_get.type = this.get_type(types[unit_key].type);
                        }
                    } catch (e) {
                        this.log.debug(`Could not read type for ${get_command}: ${e}`);
                    }

                    dp.gets.push(obj_get);
                    continue;
                }

                if (get_command.substring(0, 3) === 'set' && get_command.length > 3) {
                    const obj_set = {
                        name: get_command.substring(3),
                        description: desc,
                        polling: 'nicht möglich',
                        command: get_command,
                        type: 'mixed',
                    };

                    try {
                        const unit_key = cmd_raw.unit && cmd_raw.unit[0];
                        if (unit_key && types && types[unit_key]) {
                            obj_set.type = this.get_type(types[unit_key].type);
                        }
                    } catch (e) {
                        this.log.debug(`Could not read type for ${get_command}: ${e}`);
                    }

                    dp.sets.push(obj_set);
                    continue;
                }
            }
        } else {
            this.log.warn('No commands found in vito.xml');
        }

        this.log.debug(`Objects are: ${JSON.stringify(dp)}`);
        return dp;
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

            if (this.config) {
                if (this.config.states_only) {
                    for (const i in this.config.gets) {
                        if (this.config.gets[i].polling !== -1 && this.config.gets[i].polling != '-1') {
                            configToAdd.push(this.config.gets[i].name);
                        }
                    }
                } else {
                    for (const i in this.config.gets) {
                        configToAdd.push(this.config.gets[i].name);
                    }
                }
                for (const i in this.config.sets) {
                    configToAdd.push(this.config.sets[i].name);
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
                for (const i in this.config.gets) {
                    if (configToAdd.indexOf(this.config.gets[i].name) !== -1) {
                        count++;
                        this.addState(
                            pfadget,
                            this.config.gets[i].name,
                            this.config.gets[i].unit,
                            this.config.gets[i].description,
                            this.config.gets[i].type,
                            false,
                            () => {
                                if (!--count && callback) {
                                    callback();
                                }
                            },
                        );
                    }
                }
                for (const i in this.config.sets) {
                    if (configToAdd.indexOf(this.config.sets[i].name) !== -1) {
                        count++;
                        this.addState(
                            pfadset,
                            this.config.sets[i].name,
                            '',
                            this.config.sets[i].description,
                            this.config.sets[i].type,
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
            wait = true;
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
        obj.lastPoll = 0;
        toPoll['heartbeat'] = obj;

        if (this.config && this.config.gets) {
            for (const i in this.config.gets) {
                if (this.config.gets[i].polling > -1) {
                    this.log.debug(`Commands for polling: ${this.config.gets[i].command}`);
                    obj = new Object();
                    obj.name = this.config.gets[i].name;
                    obj.command = this.config.gets[i].command;
                    obj.description = this.config.gets[i].description;
                    obj.polling = this.config.gets[i].polling;
                    obj.lastpoll = 0;
                    toPoll[i] = obj;
                }
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

    getReconnectTime() {
        const reconnectDefault = 5;
        let reconnect = parseFloat(this.config.reconnect);
        if (isNaN(reconnect) || reconnect < 0.1) {
            this.log.warn('Reconnect time configuration is not a number or <0.1. Using default setting.');
            reconnect = reconnectDefault;
        }
        return reconnect * 60000;
    }

    reconnectSystem(reconnect = null) {
        if (this.ready == false) {
            return;
        }
        client.destroy();
        clearTimeout(timerWait);
        clearTimeout(timerReconnect);
        if (reconnect == null) {
            reconnect = this.getReconnectTime();
        }
        this.log.info(`Reconnecting in ${reconnect} ms.`);
        timerReconnect = setTimeout(() => {
            this.connectSystem();
        }, reconnect);
    }

    //###########################################################################################################

    //######MAIN#################################################################################################
    async main() {
        this.setState('info.timeout_connection', false, true);
        this.setState('info.connection', false, true);

        toPoll = {};
        setcommands = [];

        const answer = this.config.answer;

        let err_count = 0;

        clearTimeout(timerReconnect);
        this.setAllObjects();

        this.connectSystem();

        client.on('close', () => {
            this.setState('info.connection', false, true, err => {
                if (err) {
                    this.log.error(err);
                }
            });
            this.log.info('Disconnected from Viessmann system!');
            this.reconnectSystem();
        });

        client.on('ready', () => {
            this.setState('info.connection', true, true, err => {
                if (err) {
                    this.log.error(err);
                }
            });
            this.log.info('Connected to Viessmann system!');
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
                    this.reconnectSystem(10000);
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
            this.reconnectSystem();
        });
        client.on('timeout', () => {
            this.setState('info.connection', false, true);
            this.log.warn('Timeout connection error!');
            this.setState('info.timeout_connection', true, true);
            this.reconnectSystem();
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
     * @param [options] options for the adapter
     */
    module.exports = options => new Viessmann(options);
} else {
    // otherwise start the instance directly
    new Viessmann();
}
