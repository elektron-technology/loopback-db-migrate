#!/usr/bin/env node
'use strict';

const fs = require('fs');
const prompt = require('cli-prompt');

const dbNameFlag = process.argv.indexOf('--datasource');
const dbName = (dbNameFlag > -1) ? process.argv[dbNameFlag + 1] : 'db';

const dateSinceFlag = process.argv.indexOf('--since');
const dateSinceFilter = (dateSinceFlag > -1) ? process.argv[dateSinceFlag + 1] : '';

const migrationsFolderFlag = process.argv.indexOf('--directory');
const migrationsFolder = process.cwd() + (migrationsFolderFlag > -1 ? process.argv[migrationsFolderFlag + 1].replace(/\/?$/, '/') : '/server/migrations/');
const dbMigrationsFolder = migrationsFolder + dbName;

const appScriptFlag = process.argv.indexOf('--app-script');
const appScript = appScriptFlag > -1 ? process.argv[appScriptFlag + 1] : '/server/server.js';
const app = require(process.cwd() + appScript);

const migrationCollectionFlag = process.argv.indexOf('--migration-collection');
const migrationCollection = migrationCollectionFlag > -1 ? process.argv[migrationCollectionFlag + 1] : 'Migration';

app.on('booted', () => {
  const datasource = app.dataSources[dbName];

  if (!datasource) {
    console.log('datasource \'' + dbName + '\' not found!');
    process.exit(1);
  }

  datasource.createModel(migrationCollection, {
    "name": {
      "id": true,
      "type": "String",
      "required": true,
      "length": 100
    },
    "db": {
      "type": "String",
      "length": 100,
      "required": true
    },
    "runDtTm": {
      "type": "Date",
      "required": true
    }
  });

  // make migration folders if they don't exist
  try {
    fs.mkdirSync(migrationsFolder);
  } catch (e) {
  }

  try {
    fs.mkdirSync(dbMigrationsFolder);
  } catch (e) {
  }

  function mapScriptObjName(scriptObj) {
    return scriptObj.name;
  }

  function findScriptsToRun(upOrDown, cb) {
    const filters = {
      where: {
        name: {gte: dateSinceFilter + '' || ''}
      },
      order: (upOrDown === 'up') ? 'name ASC' : 'name DESC'
    };

    // get all local scripts and filter for only .js files
    const localScriptNames = fs.readdirSync(dbMigrationsFolder).filter(function (fileName) {
      return fileName.substring(fileName.length - 3, fileName.length) === '.js';
    });

    // create table if not exists
    datasource.autoupdate(migrationCollection, function (err) {
      if (err) {
        console.log('Error retrieving migrations:');
        console.log(err.stack);
        process.exit(1);
      }

      // get all scripts that have been run from DB
      datasource.models[migrationCollection].find(filters, function (err, scriptsRun) {
        if (err) {
          console.log('Error retrieving migrations:');
          console.log(err.stack);
          process.exit(1);
        }

        if (upOrDown === 'up') {
          const runScriptsNames = scriptsRun.map(mapScriptObjName);

          // return scripts that exist on disk but not in the db
          cb(null, localScriptNames.filter(function (scriptName) {
            return runScriptsNames.indexOf(scriptName) < 0;
          }));
        } else {
          // return all db script names
          cb(null, scriptsRun.map(mapScriptObjName));
        }
      });
    });
  }

  function migrateScripts(upOrDown) {
    return function findAndRunScripts() {
      findScriptsToRun(upOrDown, function runScripts(err, scriptsToRun) {
        if (err) {
          console.log(err);
          process.exit(1);
        }

        const migrationCallStack = [];
        let migrationCallIndex = 0;

        scriptsToRun.forEach(function (localScriptName) {
          migrationCallStack.push(function () {

            // keep calling scripts recursively until we are done, then exit
            function runNextScript(err) {
              if (err) {
                console.log('Error saving migration', localScriptName, 'to database!');
                console.log(err.stack);
                process.exit(1);
              }

              console.log(localScriptName, 'finished successfully.');
              migrationCallIndex++;
              if (migrationCallIndex < migrationCallStack.length) {
                migrationCallStack[migrationCallIndex]();
              } else {
                process.exit();
              }
            }

            try {
              // include the script, run the up/down function, update the migrations table, and continue
              console.log(localScriptName, 'running.');
              require(dbMigrationsFolder + '/' + localScriptName)[upOrDown](datasource, function (err) {
                if (err) {
                  console.log(localScriptName, 'error:');
                  console.log(err.stack);
                  process.exit(1);
                } else if (upOrDown === 'up') {
                  datasource.models[migrationCollection].create({
                    name: localScriptName,
                    db: dbName,
                    runDtTm: new Date()
                  }, runNextScript);
                } else {
                  datasource.models[migrationCollection].destroyAll({
                    name: localScriptName
                  }, runNextScript);
                }
              });
            } catch (e) {
              console.log('Error running migration', localScriptName);
              console.log(e.stack);
              process.exit(1);
            }
          });
        });

        // kick off recursive calls
        if (migrationCallStack.length) {
          migrationCallStack[migrationCallIndex]();
        } else {
          console.log('No new migrations to run.');
          process.exit();
        }
      });
    }
  }

  function stringifyAndPadLeading(num) {
    const str = num + '';
    return (str.length === 1) ? '0' + str : str;
  }

  const commands = {
    up: migrateScripts('up'),
    down: migrateScripts('down'),
    create: function create(name) {
      const cmdLineName = name || process.argv[process.argv.indexOf('create') + 1];

      if (!cmdLineName) {
        return prompt('Enter migration script name:', create);
      }

      const d = new Date();
      const year = d.getFullYear() + '';
      const month = stringifyAndPadLeading(d.getMonth() + 1);
      const day = stringifyAndPadLeading(d.getDate());
      const hours = stringifyAndPadLeading(d.getHours());
      const minutes = stringifyAndPadLeading(d.getMinutes());
      const seconds = stringifyAndPadLeading(d.getSeconds());
      const dateString = year + month + day + hours + minutes + seconds;
      const fileName = '/' + dateString + (cmdLineName && cmdLineName.indexOf('--') === -1 ? '-' + cmdLineName : '') + '.js';

      fs.writeFileSync(dbMigrationsFolder + fileName, fs.readFileSync(__dirname + '/migration-skeleton.js'));
      process.exit();
    }
  };

  const cmdNames = Object.keys(commands);

  for (let i = 0; i < cmdNames.length; i++) {
    if (process.argv.indexOf(cmdNames[i]) > -1) {
      return commands[cmdNames[i]]();
    }
  }
})
