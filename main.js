/**
 *
 * viessmann adapter
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
const utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
const net = require('net');
const xml2js = require('xml2js');
const fs = require('fs');
const ftp = require('ftp');
//Hilfsobjekt zum abfragen der Werte
let datapoints = {};
let toPoll = {};
//Zähler für Hilfsobjekt
let step = -1;
//Hilfsarray zum setzen von Werten
let setcommands = [];
// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.viessmann.0
const adapter = utils.Adapter('viessmann');

const client = new net.Socket();
const parser = new xml2js.Parser();





// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', (callback) => {
    try {
		client.destroy(); // kill client after server's response
        adapter.log.info('cleaned everything up...');
        callback();
    } catch (e) {
        callback();
    }
});

// is called if a subscribed object changes
adapter.on('objectChange', (id, obj)=> {
    // Warning, obj can be null if it was deleted
    adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});

// is called if a subscribed state changes
adapter.on('stateChange', (id, state)=> {
    // Warning, state can be null if it was deleted
	setcommands.push(String('set' + id.substring(16, id.length) + ' ' + state.val));
});


// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
/*adapter.on('message', function (obj) {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});*/

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', ()=> {
	adapter.setObjectNotExists('info.connection', {
        type: 'state',
        common: {
            name: 'connection',
            desc: 'Info über Verbindung zur Viessmann Steuerung',
        },
        native: {}
    });
    if(!adapter.config.datapoints.gets || adapter.config.new_read)readxml();
    else main();
});

//##########IMPORT XML FILE###########
function readxml(){
  //Read files
  if(adapter.config.ip === 127.0.0.1){
  fs.readFile('/etc/vcontrold/vito.xml', 'utf8', (err, data) => {
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
              adapter.extendForeignObject('system.adapter.' + adapter.namespace, {native: {datapoints: getImport(temp)}});
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
  //Create a FTP connection
  }
  else{
	  const ftp_session = new ftp;
	  
	  ftp_session.connect({
		host: adapter.config.ip,
		user: adapter.config.user_name,
		password: adapter.config.password
		});
		
		ftp_session.on('ready',()=>{
			ftp_session.get('/etc/vcontrold/vito.xml', (err, stream)=>{
				if(err){
					adapter.log.warn('cannot read vito.xml ' + err);
					adapter.setState('info.connection', false, true);
					ftp_session.end();
				}
				else{
					let xml_temp;
					stream.on('data',(result)=>{
						xml_temp = result;
					});
					stream.on('end',()=>{
						parser.parseString(xml_temp, (err, result)=> {
							if(err){
								adapter.log.warn('cannot parse vito.xml ' + err);
								adapter.setState('info.connection', false, true);
							}else{
								try{
								let temp = JSON.stringify(result);
								temp = JSON.parse(temp)
								adapter.extendForeignObject('system.adapter.' + adapter.namespace, {native: {datapoints: getImport(temp)}});
								main();
								}catch(e){
									adapter.log.warn('check vito.xml structure ' + e);
									adapter.setState('info.connection', false, true);
								}
							}
						});
					}
					
				}
			});
		});
	ftp_session.on('error',(err)=>{
		adapter.log.warn('check your FTP login dates ' + err);
		});	
  }
}
//#################################

//######IMPORT STATES######
function getImport(json) {
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
//########################

//######SET STATES#########
function addState(pfad, name, beschreibung, callback) {
    adapter.setObjectNotExists(pfad + name, {
        type: 'state',
        common: {
            name: name,
            desc: beschreibung,
        },
        native: {}
    }, callback);
}
//##########################
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
				if (name === 'connection') {
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
                    addState(pfadget, adapter.config.datapoints.gets[i].name, adapter.config.datapoints.gets[i].description, ()=> {
                        if (!--count && callback) callback();
                    });
                }
            }
			for (let i in adapter.config.datapoints.sets) {
                if (configToAdd.indexOf(adapter.config.datapoints.sets[i].name) !== -1) {
                    count++;
                    addState(pfadset, adapter.config.datapoints.sets[i].name, adapter.config.datapoints.sets[i].description, ()=> {
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

function stepPolling() {

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

    if (step === -1) {
		adapter.log.debug('Wait for next run: ' + actualMinWaitTime + ' in ms');
        setTimeout(()=> {
            stepPolling();
        }, actualMinWaitTime);

    } else {
		adapter.log.debug('Next poll: ' + toPoll[step].command +'  ' + step);
		toPoll[step].lastPoll = Date.now();
        client.write(toPoll[step].command + '\n');
    }
}

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

function split_unit(v) {
	// test if string starts with non digits, then just pass it
	if  (typeof v === 'string' && v !== "" && (/^\D.*$/.test(v))){
		return { 'value':v, 'unit':"" }
	}
	// else split value and unit
	else if (typeof v === 'string' && v !== ""){
		let split = v.match(/^([-.\d]+(?:\.\d+)?)(.*)$/);
		return {'value':split[1].trim(),  'unit':split[2].trim()};
	}
	// catch the rest
	else {
		return { 'value':v, 'unit':"" }
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

function main() {
	// set connection status to false
	adapter.setState('info.connection', false, true);

    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:
	toPoll = {};
	setcommands = [];
	
	const ip = adapter.config.ip;
	const port = adapter.config.port || 3002;
	const answer = adapter.config.answer;
	const time_out = 120000;
	let err_count = 0;
	
    commands();

	setAllObjects(()=> {
	});

	client.setTimeout(time_out);

	client.connect(port, ip, ()=> {
		adapter.setState('info.connection', true, true, (err)=> {
		 	if (err) adapter.log.error(err);
		});
		adapter.log.info('Connect with Viessmann sytem!');
		stepPolling();
	});
	client.on('close', ()=> {
		adapter.setState('info.connection', false, true, (err)=> {
		 	if (err) adapter.log.error(err);
		});
		adapter.log.info('Connection with Viessmann system disconnected!');
		client.destroy(); // kill client after server's response
	});


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
				client.destroy(); // kill client after server's response
				setTimeout(main, 10000);
			}else{
				stepPolling();
			}			
		} else if(data == 'vctrld>') {
			return;
		} else if(step == -1) {
			return;
		} else {
			err_count = 0;
			if (vctrld.test(data)) {
				data = data.substring(0, data.length - 7);
			}
			try {
				data = data.replace(/\n$/, '');
				if(answer){
					data = split_unit(data).value;
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
		adapter.log.warn('Malfunction connection--> ' + e);
		client.destroy(); // kill client after server's response
	});
    client.on('timeout', ()=> {
		adapter.setState('info.connection', false, true);
		adapter.log.warn('Timeout error connection!');
		client.destroy(); // kill client after server's response
		setTimeout(main, 10000);
	});



    // in this viessmann all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('set.*');

}