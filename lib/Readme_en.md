This adapter creates a connection with the programm [Vcontrold](https://github.com/openv/vcontrold).
You can read states and write commands to control your viessmann heating system.

You have two options to install your iobroker viessmann instance...

#### (self host as vcontrold)
Normally you dont need changes in your admin configuration.
*(Provided, the vito.xml is in the follow path: /etc/vcontrold/vito.xml)*

#### (other host as vcontrold)
You can use the SSH-tab in the instance settings page. You have to fill out the require informations in this tab.
*(Provided a functioning SSH connection to the slave.)*

After the first instance restart, the adapter read all objects from your vito.xml.
Now you can configure your instance.



#### The vito.xml need the following structure:

		```<vito>
			<devices>
				<device ID="2094" name="V200KW1" protocol="KW2"/>
			</devices>
			<commands>
				<command name='getOelverbrauch' protocmd='getaddr' >
					<addr>7574</addr>
					<len>4</len>
					<description></description>
				</command>
				<command name='getTempAbgas' protocmd='getaddr'>
					<addr>0808</addr>
					<len>2</len>
					<unit>UT</unit>
					<error>05 05</error>
					<description>Abgastemeratur in Grad C</description>
				</command>
			</commands>
		</vito>```

In the settings page you can sort your objects when you click at the table head.


## IMPORTANT!: 	
	- After a vito.xml reload, you lost all your old configured settings.


It is advisable to choose a large query interval for relatively unimportant query values.


*all pictures comes from www.viessmann.com.*
