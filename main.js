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


// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (typeof obj == 'object' && obj.message) {
        if (obj.command == 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
    main();
});

function Poll() {
        this.name = '';
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
		var pfadget = "get.";
		var pfadset = "set.";
		
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
				var clean = _states[j]._id;
			
					if (name.length < 1) {
						adapter.log.warn('No states found for ' + JSON.stringify(_states[j]));
						continue;
					}
					id = name.replace(/[.\s]+/g, '_');
					var pos = configToAdd.indexOf(name);
					if (pos != -1) {
						configToAdd.splice(pos, 1);           
					} 
					else {
						configToDelete.push(clean);
					}				
			}
        }

        if (configToAdd.length) {
            var count = 0;
            for (var r in adapter.config.datapoints.gets) {
                if (configToAdd.indexOf(adapter.config.datapoints.gets[r].name) != -1) {
                    count++;
                    addState(pfadget, adapter.config.datapoints.gets[r].name, adapter.config.datapoints.gets[r].description, function () {
                        if (!--count && callback) callback();
                    });
                }
            }
			for (var o in adapter.config.datapoints.sets) {
                if (configToAdd.indexOf(adapter.config.datapoints.sets[o].name) != -1) {
                    count++;
                    addState(pfadset, adapter.config.datapoints.sets[o].name, adapter.config.datapoints.sets[o].description, function () {
                        if (!--count && callback) callback();
                    });
                }
            }
        }
        if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {				
                adapter.log.debug("Zu löschende Objekte: " + configToDelete[e]);
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

    for(var i in toPoll) {
        if(typeof(toPoll[i].lastPoll) == 'undefined') {
            toPoll[i].lastPoll = 0;
        }
        
        var nextRun = toPoll[i].lastPoll + (toPoll[i].polling * 1000)
        var nextDiff = nextRun - time;

        if(time < nextRun) {
			if(actualMinWaitTime > nextDiff) {
				actualMinWaitTime = nextDiff;
			}
             continue;
        }
        
        if(nextDiff < actualMinWaitTime) {
            actualMinWaitTime = nextDiff;
            step = i;
        }
    }
    
    if(step === -1) {
		adapter.log.debug("Wait for next Run: " + actualMinWaitTime + " in ms");
        setTimeout(function () {
			
            stepPolling();
        }, actualMinWaitTime);

    } else {
	adapter.log.debug("Next poll: "+toPoll[step].name);
	toPoll[step].lastPoll = Date.now();
        client.write(toPoll[step].name + '\n');
    }
}

function commands() {
	
		for (var q in adapter.config.datapoints.gets) {	
			if(adapter.config.datapoints.gets[q].polling > -1) {
				adapter.log.debug("commandos for polling: " + adapter.config.datapoints.gets[q].name);
				var dp = new Poll();
					dp.name = adapter.config.datapoints.gets[q].name;
					dp.description = adapter.config.datapoints.gets[q].description;
					dp.polling = adapter.config.datapoints.gets[q].polling;
					dp.lastpoll = 0;
					toPoll[q] = dp;
				continue;
			}
		}
}

function main() {

    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:
	toPoll = {};
	var ip = adapter.config.ip;
	var port = adapter.config.port;
		
    commands();
	setAllObjects(function() {
	});
	
	client.setTimeout(600000);
        
	client.connect(port, ip, function() {
		adapter.log.debug('Connect with Viessmann sytem!');
		client.write('dummy\n');		
		stepPolling();
	});
	client.on('close', function() {
		adapter.log.debug('Disable connection with Viessmann system!');
		client.destroy(); // kill client after server's response
	});
	client.on('data', function(data) {
		data = String(data);
		if(data == 'vctrld>') return;
		 if(step == -1 || (""+data).substring(0,3) == 'ERR') return;
		 
		 adapter.setState("get." + toPoll[step].name, data, true, function (err) {
		 if (err) adapter.log.error(err);
		 stepPolling();
		 });
		 
    
	});
	client.on('error', function() {
		adapter.log.warn('Malfunction connection');
		client.destroy(); // kill client after server's response
	});
    client.on('timeout', function() {
		adapter.log.warn('Timeout error connection!');
		client.destroy(); // kill client after server's response
	});
	
	
	
    // in this viessmann all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');

}