'use strict';


// <editor-fold desc="IMPORTS">

require('express-group-routes');
require("./util/functions");

const fs = require('fs');

const yargs = require('yargs');

const utils = require("./util/utils");
const database = require("./database/database");
const logger = require("./util/logger");
const config = require("./config");

const express = require('express');
const expressAuth = require('express-basic-auth');
const expressWs = require('express-ws');

const bodyParser = require('body-parser');

const v1Realtime = require("./endpoint/geojson/realtime");
const v1Lines = require("./endpoint/geojson/lines");
const v1Receiver = require("./endpoint/geojson/receiver");
const v1Stops = require("./endpoint/geojson/stops");

const vdv = require("./endpoint/vdv/vdv");

const v2Realtime = require("./endpoint/gtfs/realtime");

const v2Api = require("./endpoint/geojson/api");

const appRealtime = require("./endpoint/app/realtime");
const appBeacons = require("./endpoint/app/beacons");

// </editor-fold>


utils.startErrorReporting();

process.on('uncaughtException', (err) => {
    logger.error('Caught exception: ');
    console.log(err);

    utils.handleError(err);

    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at: Promise', promise, 'reason:', reason);
});


// ====================================================== ARGS =========================================================

let args = yargs
    .command('serve', 'Starts the server', (yargs) => {
        yargs.option('port', {
            describe: 'Port to bind the server on',
            default: 80,
            type: 'number'
        }).check(function (argv) {
            return !isNaN(parseFloat(argv.port)) && isFinite(argv.port);
        })
    }, (argv) => {
        startDatabase()
    })
    .strict(true)
    .demandCommand()
    .option('verbose', {
        alias: 'v',
        default: false
    })
    .option('color', {
        alias: 'c',
        default: false
    })
    .argv;


// ======================================================= APP =========================================================

const app = express();
const ws = expressWs(app);

app.use(logRequests);
app.use(checkForRunningImport);

app.use(bodyParser.json({
    limit: '16mb'
}));

app.use(bodyParser.urlencoded({
    extended: false,
    limit: '16mb'
}));

app.use(bodyParser.raw({
    limit: '16mb'
}));

// <editor-fold desc="ROUTES">

const authConfig = { users: config.users }

app.use("/vdv/import", expressAuth(authConfig));
app.use("/v2/import", expressAuth(authConfig));
app.use("/firebase", expressAuth(authConfig));


// TODO: Add better method to server GTFS (and upload)
app.use('/gtfs', express.static('static/gtfs'));


app.set('jsonp callback name', 'jsonp');


// This needs to be the first router. Do not move it further down.
app.get('/*', (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    next();
});

if (fs.existsSync(__dirname + '/static/index.html')) {
    app.get('/', (req, res) => {
        res.sendFile(__dirname + '/static/index.html');
    });
}

app.group("/vdv", (router) => {
    router.post("/import", vdv.upload);
    router.get("/validity/:date", vdv.validity);
    router.get("/zip", vdv.downloadAppZip);

    router.get("/generateAppZip", vdv.generateAppZip);
    router.get("/generateGtfs", vdv.generateGtfs);

    router.get("/list", vdv.listVdvZips);
    router.get("/list/:name", vdv.downloadVdvZip);
});

app.group("/geojson", (router) => {
    router.get("/realtime", v1Realtime.positions);
    router.get("/realtime/lines/:lines", v1Realtime.positions);
    router.get("/realtime/vehicle/:vehicle", v1Realtime.positions);

    router.post("/receiver", (req, res) => {
        v1Receiver.updatePositions(req, res);

        setTimeout(notifyPositionsSubscribers, 0);
    });

    router.ws("/realtime/stream", registerPositionsSubscriber);

    router.get("/stops", v1Stops.stops);
    router.get("/:stop/buses", v1Stops.nextBusesAtStop);
    router.get("/:tripId/stops", v1Stops.stopsForTrip);

    router.get("/lines/all", v1Lines.fetchAllLinesAction);

    // TODO: fix this call since it's just throwing exceptions
    router.get("/lines", v1Lines.fetchLinesAction);
});

app.group("/app", (router) => {
    router.get("/realtime", appRealtime.positions);
    router.get("/realtime/delays", appRealtime.delays);

    router.get("/realtime/line/:lines", appRealtime.positions);
    router.get("/realtime/trip/:trip", appRealtime.positions);
    router.get("/realtime/vehicle/:vehicle", appRealtime.positions);

    router.post("/beacons/buses", appBeacons.insertBuses);
    router.post("/beacons/busstops", appBeacons.insertBusStops);
});

app.group("/gtfs", (router) => {
    router.get("/realtime", v2Realtime.positions);
});

app.group("/v2", (router) => {
    router.post("/import", v2Api.importData);

    router.get("/calendar.csv", v2Api.gtfs.getCalendar);
    router.get("/calendar.txt", v2Api.gtfs.getCalendar);
    router.get("/calendar_dates.csv", v2Api.gtfs.getCalendarDates);
    router.get("/calendar_dates.txt", v2Api.gtfs.getCalendarDates);
    router.get("/calendar", v2Api.getServices);

    router.get("/services", v2Api.getServices);
    router.get("/services/active", v2Api.getActiveServicesForToday);
    router.get("/services/active/:date", v2Api.getActiveServicesForDate);

    router.get("/agency.csv", v2Api.gtfs.getAgency);
    router.get("/agency.txt", v2Api.gtfs.getAgency);

    router.get("/routes.csv", v2Api.gtfs.getRoutes);
    router.get("/routes.txt", v2Api.gtfs.getRoutes);
    router.get("/routes", v2Api.getRoutes);
    router.get("/routes/service/:serviceID", v2Api.getRoutesByService);
    router.get("/routes/:routeID", v2Api.getRoute);

    router.get("/variants/:variantID.geojson", v2Api.getVariantGeometryAsGeoJSON);
    router.get("/variants/:variantID.kml", v2Api.getVariantGeometryAsKML);

    router.get("/trips.csv", v2Api.gtfs.getTrips);
    router.get("/trips.txt", v2Api.gtfs.getTrips);
    router.get("/trips", v2Api.getTrips);
    router.get("/trips/route/:routeID", v2Api.getTripsByRoute);
    router.get("/trips/service/:serviceID", v2Api.getTripsByService);
    router.get("/trips/route/:routeID/service/:serviceID", v2Api.getTripsByRouteAndService);
    router.get("/trips/:tripID", v2Api.getTrip);

    router.get("/stops.csv", v2Api.gtfs.getStops);
    router.get("/stops.txt", v2Api.gtfs.getStops);
    router.get("/stops", v2Api.getStops);
    router.get("/stops/:stopID", v2Api.getStop);

    router.get("/stop_times.csv", v2Api.gtfs.getStopTimes);
    router.get("/stop_times.txt", v2Api.gtfs.getStopTimes);
    router.get("/stop-times", v2Api.getStopTimes);
    router.get("/stop-times/after/:afterTime", v2Api.getStopAfter);
    router.get("/stop-times/stop/:stopID", v2Api.getStopTimesByStop);
    router.get("/stop-times/stop/:stopID/after/:afterTime", v2Api.getStopTimesByStopAfter);
    router.get("/stop-times/trip/:tripID", v2Api.getStopTimesByTrip);
    router.get("/stop-times/trip/:tripID/after/:afterTime", v2Api.getStopTimesByTripAfter);
});

app.get("/v2/docs/swagger.yaml", function (req, res) {
    var swagger = fs.readFileSync(__dirname + '/docs/apiv2/swagger.yaml', 'utf8');
    swagger = swagger.replace('host: "realtimebus.noi.bz.it"', 'host: "' + config.application.baseUrl.replace(/(^\w+:|^)\/\//, '') + '"');
    res.status(200).send(swagger);
});

app.use("/v2/docs", express.static('docs/apiv2'));

app.group("/firebase", (router) => {
    router.get("/sync", function (req, res) {
        require("./util/firebase").syncAll();

        res.status(200).json({success: true});
    });
});

app.get("/status", function (req, res) {
    res.status(200).json({success: true});
});

// TODO protect or remove this endpoint
// app.get("/stop", function (req, res) {
//     res.status(200).json({success: true});
//     process.exit(1);
// });

// </editor-fold>


app.use(function (req, res) {
    logger.error(`404: ${req.method} ${req.url}`);

    res.status(404).json({
        error: {
            code: 404,
            message: "The requested URL was not found on this server."
        }
    });
});


// =================================================== FUNCTIONS =======================================================

function startDatabase() {
    database.connect().then(() => {
        logger.warn("Connected to database");

        startServer();
    });
}

function startServer() {
    let listener = app.listen(args.port, function () {
        logger.warn(`Server started on port ${listener.address().port}`)
    })
}

function registerPositionsSubscriber(client) {
    client.channel = 'positions';
}

function notifyPositionsSubscribers() {
    v1Realtime.getPositions().then((positions) => {
        ws.getWss().clients.forEach((client) => {
            if (client.channel === 'positions') {
                client.send(JSON.stringify(positions));
            }
        });
    });
}


// =================================================== MIDDLEWARE ======================================================

function logRequests(req, res, next) {
    logger.warn(`${req.method} ${req.url} (${req.connection.remoteAddress})`);
    next();
}

function checkForRunningImport(req, res, next) {
    if (config.vdv_import_running) {
        // logger.info(`Import is running, skipping request '${req.url}'`);
        res.status(503).json({success: false, error: "VDV import is running. Please wait for it to complete."});

        return;
    }

    next();
}
