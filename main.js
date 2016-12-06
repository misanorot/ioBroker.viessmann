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

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.viessmann.0
var adapter = utils.adapter('viessmann');

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
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


function addState(pfad, name, beschreibung, einheit, callback) {
    adapter.setObjectNotExists(pfad + name, {
        type: 'state',
        common: {
            name: name,
            desc: beschreibung,
			unit: einheit
           
        },
        native: {}
    }, callback);	
}

function setAllObjects(callback) {
	adapter.getStatesOf(function (err, _states) {
        
		var configToDelete = [];
        var configToAdd    = [];
        var k;
        var id;
		var pfad = "get.";
		
        if (adapter.config.getvalues) {
            for (k = 0; k < adapter.config.getvalues.length; k++) {
                configToAdd.push(adapter.config.getvalues[k].befehl);
            }
        }

        if (_states) {
            for (var j = 0; j < _states.length; j++) {
				
                var befehl = _states[j].common.name;
				var ignor = /jsontable/;
				var clean = _states[j]._id;
				
				if(ignor.test(befehl)) {
					continue;
				}
				else {
					if (befehl.length < 1) {
						adapter.log.warn('No states found for ' + JSON.stringify(_states[j]));
						continue;
					}
					id = befehl.replace(/[.\s]+/g, '_');
					var pos = configToAdd.indexOf(befehl);
					if (pos != -1) {
						configToAdd.splice(pos, 1);           
					} 
					else {
						configToDelete.push(clean);
					}
				}
			}
        }

        if (configToAdd.length) {
            var count = 0;
            for (var r = 0; r < adapter.config.getvalues.length; r++) {
                if (configToAdd.indexOf(adapter.config.getvalues[r].befehl) != -1) {
                    count++;
                    addState(pfad, adapter.config.getvalues[r].befehl, adapter.config.getvalues[r].beschreibung, adapter.config.getvalues[r].einheit, function () {
                        if (!--count && callback) callback();
                    });
                }
            }
        }
        if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {				
                //id = configToDelete[e].replace(/[.\s]+/g, '_');
				adapter.log.debug("Zu löschende Objekte: " + configToDelete[e]);
                adapter.delObject(configToDelete[e]);
            }
        }
        if (!count && callback) callback();
    });
}


function pollingget(ip, port, interval) {
	
	adapter.getStatesOf(function (err, _states) {
		
		var cmds = "";
		var json = [];
		var countdown = (interval*60000)-15000;
		
		if(err) {
			adapter.log.error(err);
		}
		else {
			for(var find in adapter.config.getvalues) {
				cmds = cmds + adapter.config.getvalues[find].befehl + "\r\n";
			}
		
		cmds = cmds + "quit\r\n";
    
		var z = 0;
		var antwort = [];
		var client = new net.Socket();
    
			client.setTimeout(countdown);
        
			client.connect(port, ip, function() {
				adapter.log.debug('Mit Viessmann Anlage verbunden');
				adapter.log.debug('Sendebefehle: ' + cmds);
				client.write(cmds);
			});

			client.on('data', function(data) {
				var str = String(data);
				var ignorvctrld = /^vctrld/;
				var stoperr = /^vctrld>ERR/;
				var commanderr = /^vctrld>ERR: command unknown/;
	    
				adapter.log.debug(data);
		
				if(stoperr.test(str)) {
					adapter.log.warn('Fehler bei der Übertragung'); 
				}
				if(commanderr.test(str)) {
					adapter.log.warn('Sendebefehle überprüfen'); 
				}
				if(ignorvctrld.test(str)) {
					//Ignoriert die erste Antwort
				}
				else {
					antwort[z] = data;
					z++;
				}
			});

			client.on('close', function() {
				adapter.log.debug('Verbindung mit Viessmann Anlage beendet');
				client.destroy(); // kill client after server's response
				adapter.log.debug('Anzahl gesendeter Befehle: ' + adapter.config.getvalues.length + ' / Anzahl empfangender Daten: ' + antwort.length);
				
				if((adapter.config.getvalues.length) == antwort.length) {
					for(var i in antwort) {
						var str = String(antwort[i]);
						adapter.setState("get." + adapter.config.getvalues[i].befehl, str);
						if(isNaN(str)) {
							json.push({"Datenpunkt": _states[i].common.desc, "Wert": str});
						}
						else {
							var wandel = parseFloat(str);
							json.push({"Datenpunkt": _states[i].common.desc, "Wert": wandel});
						}						
					}
				adapter.setState("jsontable", JSON.stringify(json));
				adapter.log.debug("JSON.Table: " + JSON.stringify(json));
				}
			});

			client.on('error', function() {
				adapter.log.warn('STÖRUNG Verbindung Heizung');
				client.destroy(); // kill client after server's response
			});
        
			client.on('timeout', function() {
				adapter.log.warn('Zeitüberschreitung Verbindung Heizung');
				client.destroy(); // kill client after server's response
			});
		}
	});
}
	
	


function main() {

    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:

	adapter.setObject("jsontable", {
        type: 'state',
        common: {
			type: "state",
			role: "indicator",
            name: "jsontable",
            desc: "Zur Anzeige in VIS"           
        },
        native: {}
    });	
	
	setAllObjects(function() {
		var _ip = adapter.config.ip;
		var _port = adapter.config.port;
		var _interval = parseInt(adapter.config.interval, 10);
		
		if(_interval<1) {
			_interval = 1;
		}
		if(isNaN(_interval)) {
			adapter.log.error('Bitte Abfragezeit überfrüfen');
		}
		else {
			setInterval(function() {
				pollingget(_ip, _port, _interval);
			}, 60000 * _interval);
		}
	});
 
    // in this viessmann all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');

}