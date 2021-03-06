
const Sitemap = require('../lib/navigation/sitemap').Sitemap;
const _ = require('lodash');
const { nest } = require('./util');
const debug = require('debug')('routes');

var router = require('express').Router();

/************************************************************************
 ***
 *** Utilities
 ***
 ***/

/** Utility function for constructing an application url from path components
 *
 * @note also available in res.locals (see app.initialize)
 */

function appurl (...args) {
    return '/' + _.map(args, encodeURIComponent).join('/');
}

/** Construct a 404 Error that may be thrown from a query function
 *  or passed to next() from a middleware function
 *
 * @param what - type of thing that wasn't found
 * @param name - name of thing that wasn't found
 */

function notfound (what, name) {
    var err = new Error(what + ' ' + (name || '') + ' not found');
    err.status = 404;
    return err;
}

/** Route middleware constructor.
 *  Render specified view.
 *  If req.path is in the sitemap, navigation information will be added.
 */
function sendpage (view) {
    return function(req, res) {
        var sitemap = req.app.get('sitemap');
        res.locals.toplinks = sitemap.toplinks;
        res.locals.nav = sitemap.navinfo(req.path);
        res.render(view);
    };
}

/** Response handler for TOC pages.
 *  All information is taken from the sitemap.
 */
function contentsPage (req, res, next) {
    var sitemap = req.app.get('sitemap');
    res.locals.toplinks = sitemap.toplinks;
    res.locals.nav = sitemap.navinfo(req.path);
    if (res.locals.nav) {
        res.render('contents');
    } else {
        next(notfound('page', req.path));
    }
}

/** Route middleware constructor
 *
 *  @param qf - query function.
 *
 * qf takes an opencontrol#Database and the query parameters
 * and returns a hash. All keys in the hash are added to res.locals.
 */
function runquery (qf) {
    return function (req, res, next) {
        try {
            let db = req.app.get('db');
            let ans = qf(db, req.params);
            _.forEach(ans, (v,k) => res.locals[k] = v);
        } catch (err) {
          res.locals.params = req.params;
          return next(err);
        }
        next();
    };
}

/************************************************************************
 ***
 *** Queries
 ***
 ***/

/** 
 * Ensure that value is non-null, throws 404 error if
 * @param {any} val
 */
function assertFound (val) {
    if (!val) {
        var err = new Error('not found');
        err.status = 404;
        throw err;
    }
    return val;
}

function populateSatisfaction(db, sat) {
    sat.control = db.controls.findByKey(sat.standard_key,sat.control_key);
    sat.component = db.components.findByKey(sat.component_key);
    return sat;
}

var findControl = (db, params) => ({
    control: assertFound(db.controls.findByKey(params.standard,params.control)),
    satisfied: db.satisfactions.chain()
        .filter({ standard_key: params.standard, control_key: params.control })
        .sortBy('component_key')
        .map(sat => populateSatisfaction(db, sat))
        .value(),
    certifications: db.certifications.chain()
        .filter({ standard_key: params.standard, control_key: params.control })
        .value(),
});

var findComponent = (db, params) => ({
    component: assertFound(db.components.findByKey(params.component)),
    satisfies: db.satisfactions.chain()
        .filter({ component_key: params.component })
        .sortBy(['standard_key', 'control_key'])
        .map(sat => populateSatisfaction(db, sat))
        .value(),
});

/************************************************************************
 ***
 *** Routes
 ***
 ***/

/** Constructs links to various application entities based on primary key.
 *  @note also available in res.locals.
 */
const linkto = {
    component: (component)      => appurl('components', component),
    standard: (standard)        => appurl('standards', standard),
    control: (standard,control) => appurl('standards', standard, control),
    certfication: (cert)        => appurl('certifications', cert),
    family: (standard,family)   => appurl('family', standard, family),
};

appurl.component = component => linkto.component(component.key);
appurl.control = control => linkto.control(control.standard_key, control.key);

router.get('/', sendpage('index'));

router.get('/components', contentsPage);
router.get('/components/:component',
    runquery(findComponent), sendpage('component'));

router.get('/standards', contentsPage);
router.get('/standards/:standard_key', contentsPage);
router.get('/standards/:standard/:control',
        runquery(findControl), sendpage('control'));

router.get('/family/:standard_key/:family', contentsPage);

router.get('/certifications', contentsPage);
router.get('/certifications/:certification', contentsPage);
router.get('/certifications/:certification/:stdfamily', contentsPage);
router.get('/certifications/:certification/:standard/:control',
        runquery(findControl), sendpage('control'));

/************************************************************************
 ***
 *** Table of contents.
 ***
 ***/

function sitemap (db) {
    var site = new Sitemap;

    site.begin('/components', 'Components');
    for (var component of db.components.records) {
        site.add(appurl.component(component), component.key, component.name);
    }
    site.end();

    site.begin('/standards', 'Standards');
    _(nest(db.controls.records, ['standard_key', 'family']))
    .forEach(function (group, standard_key) {
        debug('creating toc for standard %s', standard_key);
        site.begin(appurl('standards', standard_key), standard_key);
        _(group).forEach(function (controls, family) {
            debug('creating subtoc for family %s', family);
            site.begin(linkto.family(standard_key, family), family);
            _(controls).forEach(function (control) {
                debug('creating tocentry for %s', control.key);
                site.add(appurl.control(control),
                    control.key, control.key + ' - ' + control.name);
                });
            site.end();
        });
        site.end();
    });
    site.end();

    site.begin('/certifications', 'Certifications');
    db.controls.chain()
    .flatMap(control =>
        db.certifications.chain()
        .filter({ standard_key:control.standard_key, control_key:control.key })
        .map(certification => _.assign({},certification, control))
        .value())
    .groupBy('certification')
    .forEach(function (certcontrols, certification) {
        debug('creating toc for certification %s (%d controls)',
                certification, certcontrols.length);
        site.begin(appurl('certifications', certification), certification);
        _(certcontrols)
        .groupBy(control => control.standard_key + '-' + control.family)
        .forEach(function (controls, stdfamily) {
            debug('creating tocentry for %s', stdfamily);
            site.begin(appurl('certifications', certification, stdfamily));
            controls.forEach(control =>
                site.add(
                    appurl('certifications',
                        certification,
                        control.standard_key,
                        control.key),
                    control.key, control.key + ' - ' + control.name));
            site.end();
        });
        site.end();
    }).value();

    site.end();

    return site;
}

module.exports.router = router;
module.exports.sitemap = sitemap;
module.exports.appurl = appurl;
module.exports.linkto = linkto;
