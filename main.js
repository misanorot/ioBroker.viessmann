/**
 *
 * viessmann adapter
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
var net = require('net');
//Hilfsobjekt zum abfragen der Werte
var toPoll = {};
//Zähler für Hilfsobjekt
var step = -1;
//Hilfsarray zum setzen von Werten
var setcommands = [];
var client = new net.Socket();

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.viessmann.0
var adapter = utils.adapter('viessmann');

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
		client.destroy(); // kill client after server's response
        adapter.log.info('cleaned everything up...');
        callback();
    } catch (e) {
        callback();
    }
});

// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
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
adapter.on('ready', function () {
	adapter.setObjectNotExists('info.connection', {
        type: 'state',
        common: {
            name: 'connection',
            desc: 'Info über Verbindung zur Viessmann Steuerung',           
        },
        native: {}
    });
    main();
});

function Poll() {
		this.name = '';
        this.command = '';
        this.description = '';
        this.polling = '';
		this.lastpoll = '';
    }

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

function setAllObjects(callback) {
	adapter.getStatesOf(function (err, _states) {
        
		var configToDelete = [];
        var configToAdd    = [];
        var id;
		var pfadget = 'get.';
		var pfadset = 'set.';
		
        if (adapter.config.datapoints) {
            for (var k in  adapter.config.datapoints.gets) {
                configToAdd.push(adapter.config.datapoints.gets[k].name);
            }
			for (var l in adapter.config.datapoints.sets) {
				configToAdd.push(adapter.config.datapoints.sets[l].name);
			}
        }

        if (_states) {
            for (var j = 0; j < _states.length; j++) {
				var name = _states[j].common.name;
				if (name === 'connection') {
					continue;
				}
				var clean = _states[j]._id;
			
				if (name.length < 1) {
					adapter.log.warn('No states found for ' + JSON.stringify(_states[j]));
					continue;
				}
				id = name.replace(/[.\s]+/g, '_');
				var pos = configToAdd.indexOf(name);
				if (pos !== -1) {
					configToAdd.splice(pos, 1);           
				} else {
					configToDelete.push(clean);
				}				
			}
        }

        if (configToAdd.length) {
            var count = 0;
            for (var r in adapter.config.datapoints.gets) {
                if (configToAdd.indexOf(adapter.config.datapoints.gets[r].name) !== -1) {
                    count++;
                    addState(pfadget, adapter.config.datapoints.gets[r].name, adapter.config.datapoints.gets[r].description, function () {
                        if (!--count && callback) callback();
                    });
                }
            }
			for (var o in adapter.config.datapoints.sets) {
                if (configToAdd.indexOf(adapter.config.datapoints.sets[o].name) !== -1) {
                    count++;
                    addState(pfadset, adapter.config.datapoints.sets[o].name, adapter.config.datapoints.sets[o].description, function () {
                        if (!--count && callback) callback();
                    });
                }
            }
        }
        if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {				
                adapter.log.debug('States to delete: ' + configToDelete[e]);
                adapter.delObject(configToDelete[e]);
            }
        }
        if (!count && callback) callback();
    });
}
	
function stepPolling() {
    
    step = -1;   
    var actualMinWaitTime = 1000000;
    var time = Date.now();
	
	if (setcommands.length > 0) {
		var cmd = setcommands.shift();
		adapter.log.debug('Set command: ' + cmd);
		client.write(cmd + '\n');
		return;
	}

    for (var i in toPoll) {
        if (typeof toPoll[i].lastPoll === 'undefined') {
            toPoll[i].lastPoll = time;
        }
        
        var nextRun = toPoll[i].lastPoll + (toPoll[i].polling * 1000);
        var nextDiff = nextRun - time;

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
        setTimeout(function () {			
            stepPolling();
        }, actualMinWaitTime);

    } else {
		adapter.log.debug('Next poll: ' + toPoll[step].command);
		toPoll[step].lastPoll = Date.now();
        client.write(toPoll[step].command + '\n');
    }
}

function commands() {
	for (var q in adapter.config.datapoints.gets) {	
		if (adapter.config.datapoints.gets[q].polling > -1) {
			adapter.log.debug('Commands for polling: ' + adapter.config.datapoints.gets[q].command);
			var dp = new Poll();
			dp.name = adapter.config.datapoints.gets[q].name;
			dp.command = adapter.config.datapoints.gets[q].command;
			dp.description = adapter.config.datapoints.gets[q].description;
			dp.polling = adapter.config.datapoints.gets[q].polling;
			dp.lastpoll = 0;
			toPoll[q] = dp;
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
		var split = v.match(/^([-.\d]+(?:\.\d+)?)(.*)$/);
		return {'value':split[1].trim(),  'unit':split[2].trim()};
	}
	// catch the rest
	else {
		return { 'value':v, 'unit':"" }
	}
}

function roundNumber(num, scale) {
	var number = Math.round(num * Math.pow(10, scale)) / Math.pow(10, scale);
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
	
	var ip = adapter.config.ip;
	var port = adapter.config.port;
	var time_out = 60000;	
	
    commands();
	
	for (var i in adapter.config.datapoints.gets) {	
		if (adapter.config.datapoints.gets[i].polling * 1000 > time_out) {
			time_out = adapter.config.datapoints.gets[i].polling * 1000 + 60000;
		}
	}
	
	
	setAllObjects(function() {
	});
	
	client.setTimeout(time_out);
        
	client.connect(port, ip, function() {
		adapter.setState('info.connection', true, true, function (err) {
		 	if (err) adapter.log.error(err);
		});
		adapter.log.debug('Connect with Viessmann sytem!');
		client.write('dummy\n');		
		stepPolling();
	});
	client.on('close', function() {
		adapter.setState('info.connection', false, true, function (err) {
		 	if (err) adapter.log.error(err);
		});
		adapter.log.debug('Disable connection with Viessmann system!');
		client.destroy(); // kill client after server's response
	});
	
	
	client.on('data', function(data) {
		data = String(data);
		var ok = /OK/;
		var fail = /ERR/;
		var vctrld = /vctrld>/;
		
		if (ok.test(data)) {
			adapter.log.debug('Send command okay!');
			stepPolling();
		} else if(fail.test(data)) {
			adapter.log.warn('Vctrld send ERROR: ' + data);
			stepPolling();
		} else if(data == 'vctrld>') {
			return;
		} else if(step == -1) {
			return;
		} else {
			if (vctrld.test(data)) {
				data = data.substring(0, data.length - 7);
			}
			try {
				data = data.replace(/\n$/, '');
				data = split_unit(data).value;
				data = roundNumber(parseFloat(data), 2);
				adapter.setState('get.' + toPoll[step].name, data, true, function (err) {
					if (err) adapter.log.error(err);
					stepPolling();
				});
			} catch(e) {
				adapter.setState('get.' + toPoll[step].name, data, true, function (err) {
					if (err) adapter.log.error(err);
					stepPolling();
				});
			}
		}    
	});
	client.on('error', function() {
		adapter.setState('info.connection', false, true);
		adapter.log.warn('Malfunction connection');
		client.destroy(); // kill client after server's response
	});
    client.on('timeout', function() {
		adapter.setState('info.connection', false, true);
		adapter.log.warn('Timeout error connection!');
		client.destroy(); // kill client after server's response
		setTimeout(main, 10000);
	});
	
	
	
    // in this viessmann all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('set.*');

}
