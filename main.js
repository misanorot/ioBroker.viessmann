/**
 *
 * viessmann adapter
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core');
const net = require('net');
const xml2js = require('xml2js');
const fs = require('fs');
const ssh = require('ssh2');
//Hilfsobjekt zum abfragen der Werte
let datapoints = {};
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

let client = null;
const parser = new xml2js.Parser();

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;

/**
 * Starts the adapter instance
 * @param {Partial<ioBroker.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'viessmann',

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: start, // Main method defined below for readability

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: (callback) => {
            try {
				clearTimeout(timerWait);
				clearTimeout(timerErr);
				clearTimeout(timerTimeout);
        clearTimeout(timerReconnect);
                adapter.log.info('cleaned everything up...');
                callback();
            } catch (e) {
                callback();
            }
        },

        // is called if a subscribed object changes
        objectChange: (id, obj) => {
            if (obj) {
                // The object was changed
                adapter.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
            } else {
                // The object was deleted
                adapter.log.debug(`object ${id} deleted`);
            }
        },

        // is called if a subscribed state changes
        stateChange: (id, state) => {
            if (state) {
                // The state was changed
                adapter.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
				setcommands.push(String('set' + id.substring(16, id.length) + ' ' + state.val));
            } else {
                // The state was deleted
                adapter.log.info(`state ${id} deleted`);
            }
        },

        // Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
        // requires "common.message" property to be set to true in io-package.json
        // message: (obj) => {
        // 	if (typeof obj === "object" && obj.message) {
        // 		if (obj.command === "send") {
        // 			// e.g. send email or pushover or whatever
        // 			adapter.log.info("send command");

        // 			// Send response in callback if required
        // 			if (obj.callback) adapter.sendTo(obj.from, obj.command, "Message received", obj.callback);
        // 		}
        // 	}
        // },
    }));
}





// is called when databases are connected and adapter received configuration.
// start here!
function start(){

    if(!adapter.config.datapoints.gets)readxml();
	else if(adapter.config.new_read){
		adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj)=>{
			if(err){
				adapter.log.error(err);
				return;
			}else{
				obj.native.datapoints = {};
				adapter.setForeignObject('system.adapter.' + adapter.namespace, obj, (err)=>{
					if(err){
						adapter.log.error(err);
						return;
					}
					readxml();
				});
			}

		});
	}else main();
}

//##########IMPORT XML FILE##################################################################################


function readxml(){
	adapter.log.debug('try to read xml files');
  if(adapter.config.ip === "127.0.0.1"){
	vcontrold_read(adapter.config.path + '/vcontrold.xml');
  }else{
	    //Create a SSH connection
	  const ssh_session = new ssh();
	  adapter.log.debug('try to create a ssh session');
	  ssh_session.connect({
		host: adapter.config.ip,
		username: adapter.config.user_name,
		password: adapter.config.password
		});

		ssh_session.on('ready',()=>{
			adapter.log.debug('FTP session ready');
			ssh_session.sftp ((err, sftp)=>{
				if(err){
					adapter.log.warn('cannot create a SFTP session ' + err);
					adapter.setState('info.connection', false, true);
					ssh_session.end();
				}
				else{
					const moveVcontroldFrom =  adapter.config.path + '/vcontrold.xml';
					const moveVcontroldTo = __dirname + '/vcontrold.xml';
					const moveVitoFrom =  adapter.config.path + '/vito.xml';
					const moveVitoTo = __dirname + '/vito.xml';
					adapter.log.debug('Try to read Vito from: ' + moveVitoFrom + ' to: ' + __dirname);

					sftp.fastGet(moveVitoFrom, moveVitoTo , {},(err)=>{
						if(err){
							adapter.log.warn('cannot read vito.xml from Server: ' + err);
							adapter.setState('info.connection', false, true);
							ssh_session.end();
						}
						adapter.log.debug('Copy vito.xml from server to host successfully');
						sftp.fastGet(moveVcontroldFrom, moveVcontroldTo , {},(err)=>{
							if(err){
								adapter.log.warn('cannot read vcontrold.xml from Server: ' + err);
								vcontrold_read(moveVcontroldTo);
								ssh_session.end();
							}
							adapter.log.debug('Copy vcontrold.xml from server to host successfully');
							vcontrold_read(moveVcontroldTo);
						});
					});
				}
			});
		});

	ssh_session.on('close',()=>{
		adapter.log.debug('SSH connection closed');
		});

	ssh_session.on('error',(err)=>{
		adapter.log.warn('check your SSH login dates ' + err);
		});
  }
}


function vcontrold_read(path, callback){
	fs.readFile(path, 'utf8', (err, data) => {
		if(err){
			adapter.log.warn('cannot read vcontrold.xml ' + err);
			vito_read();
		}
		else{
			parser.parseString(data, (err, result)=> {
			if(err){
				adapter.log.warn('cannot parse vcontrold.xml --> cannot use units  ' + err);
				vito_read();
			}
			else{
				let temp;
				try{
					temp = JSON.stringify(result);
					temp = JSON.parse(temp);
				}
				catch(e){
					adapter.log.warn('check vcontrold.xml structure:  ' + e);
					adapter.setState('info.connection', false, true);
					vito_read();
					return;
				}
				let units = {};
				let types = {};
				for(let i in temp["V-Control"].units[0].unit){
						try{
							for (let e in temp["V-Control"].units[0].unit[i].entity){
								let obj = new Object;
								obj.unit = temp["V-Control"].units[0].unit[i].entity[0];
								units[temp["V-Control"].units[0].unit[i].abbrev[0]] = obj;
						}}catch(e){
							adapter.log.warn('check vcontrold.xml structure cannot read units:  ' + e);
						}
						try{
							for (let e in temp["V-Control"].units[0].unit[i].type){
								let obj = new Object;
								obj.type = temp["V-Control"].units[0].unit[i].type[0];
								types[temp["V-Control"].units[0].unit[i].abbrev[0]] = obj;
							}
						}catch(e){
							adapter.log.warn('check vcontrold.xml structure cannot read types:  ' + e);
						}
				}
			adapter.log.debug('Types in vcontrold.xml: ' + JSON.stringify(types));
			adapter.log.debug('Units in vcontrold.xml: ' + JSON.stringify(units));
			adapter.log.info('read vcontrold.xml successfull');
			vito_read(units, types);
			}
			});
		}
	});
}

function vito_read(units, types){
	const path_ssh = __dirname + '/vito.xml';
	const path_host = adapter.config.path + '/vito.xml';
	let path = "";

	if(adapter.config.ip === "127.0.0.1"){
		path = path_host;
	}else{
		path = path_ssh
	}
	fs.readFile(path, 'utf8', (err, data) => {
		if(err){
			adapter.log.warn('cannot read vito.xml ' + err);
			adapter.setState('info.connection', false, true);
		}
		else{
			parser.parseString(data, (err, result)=> {
			if(err){
				adapter.log.warn('cannot parse vito.xml ' + err);
				adapter.setState('info.connection', false, true);
			}
			else{
				try{
					let temp = JSON.stringify(result);
					temp = JSON.parse(temp)
					adapter.extendForeignObject('system.adapter.' + adapter.namespace, {native: {datapoints: getImport(temp, units, types), new_read: false}});
					adapter.log.info('read vito.xml successfull');
					main();
				}
				catch(e){
					adapter.log.warn('check vito.xml structure ' + e);
					adapter.setState('info.connection', false, true);
				}
			}
			});
		}
	});
}
//###########################################################################################################

//######IMPORT STATES########################################################################################
function getImport(json, units, types) {
datapoints['gets'] = {};
datapoints['sets'] = {};
datapoints['system'] = {};
  if (typeof json.vito.commands[0].command === "object") {
    datapoints.system["-ID"] = json.vito.devices[0].device[0].$.ID;
    datapoints.system["-name"] = json.vito.devices[0].device[0].$.name;
    datapoints.system["-protocol"] = json.vito.devices[0].device[0].$.protocol;

    for (let i in json.vito.commands[0].command) {
      const poll = -1;
      const get_command = (json.vito.commands[0].command[i].$.name);
      const desc = (json.vito.commands[0].command[i].description[0]);
      if (get_command.substring(0, 3) === 'get' && get_command.length > 3) {
        let obj_get = new Object();
        obj_get.name = get_command.substring(3, get_command.length);
		try{
			obj_get.unit = units[json.vito.commands[0].command[i].unit[0]].unit;
		}catch(e){
			obj_get.unit = "";
		}
		try{
			obj_get.type = get_type(types[json.vito.commands[0].command[i].unit[0]].type);
		}catch(e){
			obj_get.type = "";
		}
        obj_get.description = desc;
        obj_get.polling = poll;
        obj_get.command = get_command;
        datapoints.gets[get_command.substring(3, get_command.length)] = obj_get;
        continue;
      }
      if(get_command.substring(0, 3) === 'set' && get_command.length > 3) {
        let obj_set = new Object();
        obj_set.name = get_command.substring(3, get_command.length);
        obj_set.description = desc;
        obj_set.polling = "nicht möglich";
        obj_set.command = get_command;
        datapoints.sets[get_command.substring(3, get_command.length)] = obj_set;
        continue;
            }
    }
    return datapoints;
}
}
//###########################################################################################################

//######GET TYPES########################################################################################
function get_type(type){

	switch (type){
		case "enum":
			return "string";
		break;
		case "systime":
			return "string";
		break;
		case "cycletime":
			return "string";
		break;
		case "errstate":
			return "string";
		break;
		case "char":
			return "number";
		break;
		case "uchar":
			return "number";
		break;
		case "int":
			return "number";
		break;
		case "uint":
			return "number";
		break;
		case "short":
			return "number";
		break;
		case "ushort":
			return "number";
		break;
		default:
			return "mixed";
	}
}
//###########################################################################################################

//######SET STATES###########################################################################################
function addState(pfad, name, unit, beschreibung, type, write, callback) {
    adapter.setObjectNotExists(pfad + name, {
        "type": "state",
        "common": {
            "name": name,
			"unit": unit,
			"type": type,
            "desc": beschreibung,
			"read": true,
			"write": write
        },
        "native": {}
    }, callback);
}
//###########################################################################################################

//######CONFIG STATES########################################################################################
function setAllObjects(callback) {
	adapter.getStatesOf((err, _states)=> {

		let configToDelete = [];
        let configToAdd    = [];
        let id;
		const pfadget = 'get.';
		const pfadset = 'set.';
		let count = 0;

		if (adapter.config.datapoints) {
			if(adapter.config.states_only){
				for (let i in  adapter.config.datapoints.gets) {
					if (adapter.config.datapoints.gets[i].polling !== -1 && adapter.config.datapoints.gets[i].polling != "-1"){
						configToAdd.push(adapter.config.datapoints.gets[i].name);
					}
				}
			}else{
				for (let i in  adapter.config.datapoints.gets) {
					configToAdd.push(adapter.config.datapoints.gets[i].name);
				}
            }
			for (let i in adapter.config.datapoints.sets) {
				configToAdd.push(adapter.config.datapoints.sets[i].name);
			}
        }

        if (_states) {
            for (let i = 0; i < _states.length; i++) {
				let name = _states[i].common.name;
				if (name === 'connection' || name === 'lastPoll') {
					continue;
				}
				let clean = _states[i]._id;

				if (name.length < 1) {
					adapter.log.warn('No states found for ' + JSON.stringify(_states[i]));
					continue;
				}
				id = name.replace(/[.\s]+/g, '_');
				let pos = configToAdd.indexOf(name);
				if (pos !== -1) {
					configToAdd.splice(pos, 1);
				} else {
					configToDelete.push(clean);
				}
			}
        }

        if (configToAdd.length) {
            for (let i in adapter.config.datapoints.gets) {
                if (configToAdd.indexOf(adapter.config.datapoints.gets[i].name) !== -1) {
                    count++;
                    addState(pfadget, adapter.config.datapoints.gets[i].name, adapter.config.datapoints.gets[i].unit, adapter.config.datapoints.gets[i].description, adapter.config.datapoints.gets[i].type, false, ()=> {
                        if (!--count && callback) callback();
                    });
                }
            }
			for (let i in adapter.config.datapoints.sets) {
                if (configToAdd.indexOf(adapter.config.datapoints.sets[i].name) !== -1) {
                    count++;
                    addState(pfadset, adapter.config.datapoints.sets[i].name, "", adapter.config.datapoints.sets[i].description, "", true, ()=> {
                        if (!--count && callback) callback();
                    });
                }
            }
        }
        if (configToDelete.length) {
            for (let e = 0; e < configToDelete.length; e++) {
                adapter.log.debug('States to delete: ' + configToDelete[e]);
                adapter.delObject(configToDelete[e]);
            }
        }
        if (!count && callback) callback();
    });
}
//###########################################################################################################


//######POLLING##############################################################################################
function stepPolling() {
	clearTimeout(timerWait);
    step = -1;
    let actualMinWaitTime = 1000000;
    const time = Date.now();

	if (setcommands.length > 0) {
		let cmd = setcommands.shift();
		adapter.log.debug('Set command: ' + cmd);
		client.write(cmd + '\n');
		return;
	}

    for (let i in toPoll) {
        if (typeof toPoll[i].lastPoll === 'undefined') {
            toPoll[i].lastPoll = time;
        }

        let nextRun = toPoll[i].lastPoll + (toPoll[i].polling * 1000);
        let nextDiff = nextRun - time;

        if (time < nextRun) {
			if (actualMinWaitTime > nextDiff) {
				actualMinWaitTime = nextDiff;
			}
             continue;
        }

        if(nextDiff < actualMinWaitTime) {
            actualMinWaitTime = nextDiff;
            step = i;
        }
    }

	if(step == Object.keys(toPoll)[Object.keys(toPoll).length - 1] || step === -1)
		adapter.setState('info.lastPoll', Math.floor(time/1000));

    if (step === -1) {
		adapter.log.debug('Wait for next run: ' + actualMinWaitTime + ' in ms');
        timerWait = setTimeout(()=> {
            stepPolling();
        }, actualMinWaitTime);

    } else {
		adapter.log.debug('Next poll: ' + toPoll[step].command +'  (For Object: ' + step + ')');
		toPoll[step].lastPoll = Date.now();
        client.write(toPoll[step].command + '\n');
    }
}
//###########################################################################################################


//######CONFIGURE POLLING COMMANDS###########################################################################
function commands() {

	let obj = new Object();

		obj.name = "Dummy";
		obj.command = "heartbeat";
		obj.description = "keep the adapter to stay alive";
		obj.polling = 60;
		obj.lastpoll = 0;
		toPoll['heartbeat'] = obj;

	for (let i in adapter.config.datapoints.gets) {
		if (adapter.config.datapoints.gets[i].polling > -1) {
			adapter.log.debug('Commands for polling: ' + adapter.config.datapoints.gets[i].command);
			obj = new Object();
				obj.name = adapter.config.datapoints.gets[i].name;
				obj.command = adapter.config.datapoints.gets[i].command;
				obj.description = adapter.config.datapoints.gets[i].description;
				obj.polling = adapter.config.datapoints.gets[i].polling;
				obj.lastpoll = 0;
				toPoll[i] = obj;
		}
	}
}
//###########################################################################################################

//######CUT ANSWER###########################################################################################
function split_unit(v) {
	// test if string starts with non digits, then just pass it
	if  (typeof v === 'string' && v !== "" && (/^\D.*$/.test(v)) && !(/^-?/.test(v))){
		return v;
	}
	// else split value and unit
	else if (typeof v === 'string' && v !== ""){
		let split = v.match(/^([-.\d]+(?:\.\d+)?)(.*)$/);
		return split[1].trim();
	}
	// catch the rest
	else {
		return v;
	}
}

function roundNumber(num, scale) {
	let number = Math.round(num * Math.pow(10, scale)) / Math.pow(10, scale);
	if (num - number > 0) {
		return (number + Math.floor(2 * Math.round((num - number) * Math.pow(10, (scale + 1))) / 10) / Math.pow(10, scale));
	}
	else {
		return number;
  }
}
//###########################################################################################################

//######MAIN#################################################################################################
function main() {
	// set connection status to false
	adapter.setState('info.connection', false, true);
    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:
	toPoll = {};
	setcommands = [];
  client = null;
  client = new net.Socket();

	const ip = adapter.config.ip;
	const port = adapter.config.port || 3002;
	const answer = adapter.config.answer;
	const time_out = 120000;
	let err_count = 0;

	clearTimeout(timerErr);
  clearTimeout(timerReconnect);

	setAllObjects(()=> {
	});

	client.setTimeout(time_out);

	client.connect(port, ip, ()=> {
	});
	client.on('close', ()=> {
		adapter.setState('info.connection', false, true, (err)=> {
		 	if (err) adapter.log.error(err);
		});
		adapter.log.info('Connection with Viessmann system disconnected!');
		client.destroy(); // kill client after server's response
	});

  client.on('ready', ()=> {
    adapter.setState('info.connection', true, true, (err)=> {
		 	if (err) adapter.log.error(err);
		});
		adapter.log.info('Connect with Viessmann sytem!');
    commands();
		stepPolling();
  })

	client.on('data', (data)=> {
		data = String(data);
		const ok = /OK/;
		const fail = /ERR/;
		const vctrld = /vctrld>/;


		if (ok.test(data)) {
			adapter.log.debug('Send command okay!');
			stepPolling();
		} else if(fail.test(data) && step !== 'heartbeat') {
			adapter.log.warn('Vctrld send ERROR: ' + data);
			err_count++
			if(err_count > 5 && adapter.config.errors){
				adapter.setState('info.connection', false, true);
				adapter.log.warn('Vctrld send too many errors, restart connection!');
        client.end();
				client.destroy(); // kill client after server's response
				clearTimeout(timerWait);
				timerErr = setTimeout(main, 10000);
			}else{
				stepPolling();
			}
		} else if(data == 'vctrld>') {
			return;
		} else if(step == -1) {
			return;
		} else if(step == "") {
			return;
		}else {
			adapter.log.debug(`Received: ${data}`);
			err_count = 0;
			if (vctrld.test(data)) {
				data = data.substring(0, data.length - 7);
			}
			try {
				data = data.replace(/\n$/, '');
				if(answer){
					data = split_unit(data);
					if(!isNaN(data)) {data = roundNumber(parseFloat(data), 2);}
					adapter.setState('get.' + toPoll[step].name, data, true, (err)=> {
					if (err) adapter.log.error(err);
					stepPolling();
					});
				}
				else{
					adapter.setState('get.' + toPoll[step].name, data, true, (err)=> {
					if (err) adapter.log.error(err);
					stepPolling();
					});
				}
			} catch(e) {
				adapter.setState('get.' + toPoll[step].name, data, true, (err)=> {
					if (err) adapter.log.error(err);
					stepPolling();
				});
			}
			err_count = 0;
		}
	});
	client.on('error', (e)=> {
		adapter.setState('info.connection', false, true);
		adapter.log.error('Connection error--> ' + e);
    client.end();
		client.destroy(); // kill client after server's response
    if(timerReconnect){clearTimeout(timerReconnect)};
    timerReconnect = setTimeout(main, 300000); //Try to reconnect all 5mins
	});
    client.on('timeout', ()=> {
		adapter.setState('info.connection', false, true);
		adapter.log.error('Timeout connection error!');
    client.end();
		client.destroy(); // kill client after server's response
		clearTimeout(timerWait);
    if(timerTimeout){clearTimeout(timerTimeout)};
		timerTimeout = setTimeout(main, 10000);
	});



    // in this viessmann all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('set.*');

}
//###########################################################################################################
// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
//###########################################################################################################
