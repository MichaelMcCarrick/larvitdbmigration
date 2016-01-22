'use strict';

var async = require('async'),
    exec  = require('child_process').exec,
    log   = require('winston'),
    fs    = require('fs'),
    db    = require('larvitdb');

exports = module.exports = function(options) {
	options = options || {};

	if (options.tableName            === undefined) options.tableName            = 'db_version';
	if (options.migrationScriptsPath === undefined) options.migrationScriptsPath = './dbmigration';

	log.verbose('larvitdbmigration: Started with options: ' + JSON.stringify(options));

	// Resolve ./ paths to be relative to application path
	if (options.migrationScriptsPath.substring(0, 2) === './') {
		options.migrationScriptsPath = process.cwd() + '/' + options.migrationScriptsPath.substring(2);
	}

	function getLock(cb) {
		db.query('UPDATE `' + options.tableName + '` SET running = 1', function(err, res) {
			if (err) {
				cb(err);
				return;
			}

			if (res.changedRows === 0) {
				log.info('larvitdbmigration: Another process is running the migrations, wait and try again soon.');
				setTimeout(function() {
					getLock(cb);
				}, 500);
			} else {
				cb();
			}
		});
	}

	return function(cb) {
		var tasks = [],
		    curVer;

		function runScripts(startVersion, cb) {
			log.verbose('larvitdbmigration: runScripts() - Started with startVersion: "' + startVersion + '"');
			fs.readdir(options.migrationScriptsPath, function(err, items) {
				var sql = 'UPDATE `' + options.tableName + '` SET version = ' + parseInt(startVersion) + ';',
				    cmd,
				    i;

				if (err) {
					log.warn('larvitdbmigration: runScripts() - Could not read migration script path "' + options.migrationScriptsPath + '"');
					cb();
					return;
				}

				i = 0;
				while (items[i] !== undefined) {
					if (items[i] === startVersion + '.js') {
						log.info('larvitdbmigration: runScripts() - Found js migration script #' + startVersion + ', running it now.');
						require(options.migrationScriptsPath + '/' + startVersion + '.js')(function(err) {
							if (err) {
								log.error('larvitdbmigration: runScripts() - Got error running migration script #' + startVersion + ': ' + err.message);
								cb(err);
								return;
							}

							log.info('larvitdbmigration: runScripts() - Js migration script #' + startVersion + ' ran. Updating database version and moving on.');
							db.query(sql, function(err) {
								if (err) {
									cb(err);
									return;
								}

								runScripts(parseInt(startVersion) + 1, cb);
							});
						});

						return;
					} else if (items[i] === startVersion + '.sql') {
						log.info('larvitdbmigration: runScripts() - Found sql migration script #' + startVersion + ', running it now.');

						cmd = 'mysql -u ' + db.conf.user + ' -p' + db.conf.password;

						if (db.conf.host) {
							cmd += ' -h ' + db.conf.host;
						}

						cmd += ' ' + db.conf.database + ' < ' + options.migrationScriptsPath + '/' + items[i];

						exec(cmd, function(err, stdout, stderr) {
							var customErr;

							if (err) {
								cb(err);
								return;
							}

							if (stderr) {
								customErr = new Error('stderr is not empty: ' + stderr);
								log.error('larvitdbmigration: ' + customErr.message);
								cb(customErr);
								return;
							}

							log.info('larvitdbmigration: runScripts() - Sql migration script #' + startVersion + ' ran. Updating database version and moving on.');
							db.query(sql, function(err) {
								if (err) {
									cb(err);
									return;
								}

								runScripts(parseInt(startVersion) + 1, cb);
							});
						});

						return;
					}

					i ++;
				}

				// If we end up here, it means there are no more migration scripts to run
				cb();
			});
		}

		// Create table if it does not exist
		tasks.push(function(cb) {
			var sql = 'CREATE TABLE IF NOT EXISTS `' + options.tableName + '` (`id` tinyint(1) unsigned NOT NULL DEFAULT \'1\', `version` int(10) unsigned NOT NULL DEFAULT \'0\', `running` tinyint(3) unsigned NOT NULL DEFAULT \'0\', PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin COMMENT=\'Used for automatic database versioning. Do not modify!\';';
			db.query(sql, cb);
		});

		// Insert first record if it does not exist
		tasks.push(function(cb) {
			db.query('INSERT IGNORE INTO `' + options.tableName + '` VALUES(1, 0, 0);', cb);
		});

		// Lock table by setting the running column to 1
		tasks.push(getLock);

		// Get current version
		tasks.push(function(cb) {
			db.query('SELECT version FROM `' + options.tableName + '`;', function(err, rows) {
				if (err) {
					cb(err);
					return;
				}

				curVer = parseInt(rows[0].version);

				log.info('larvitdbmigration: Current database version is ' + curVer);

				cb();
			});
		});

		// Run scripts
		tasks.push(function(cb) {
			runScripts(curVer + 1, cb);
		});

		// Unlock table
		tasks.push(function(cb) {
			db.query('UPDATE `' + options.tableName + '` SET running = 0;', cb);
		});

		async.series(tasks, cb);
	};
};