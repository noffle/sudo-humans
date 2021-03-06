#!/usr/bin/env node

var http = require('http');
var fs = require('fs');
var path = require('path');
var alloc = require('tcp-bind');
var xtend = require('xtend');

var minimist = require('minimist');
var argv = minimist(process.argv.slice(2), {
    alias: {
        d: 'datadir',
        D: 'debug',
        g: 'gid',
        h: 'help',
        H: 'home',
        p: 'port',
        S: 'settings',
        u: 'uid',
        M: 'migrate'
    },
    string: ['migrate'],
    default: {
        datadir: 'sudoroom-data',
        home: path.dirname(__dirname),
        port: require('is-root')() ? 80 : 8000
    }
});
if (argv.help || argv._[0] === 'help') {
    fs.createReadStream(__dirname + '/usage.txt').pipe(process.stdout);
    return;
}

if (!argv.settings) argv.settings = argv.home + '/settings.js';
var settings = require(argv.settings);

if (argv.debug) {
    settings.debug = argv.debug;
    if (settings.sibboleth) console.log('[sibboleth] ', settings.sibboleth);
}

if (argv.gid) process.setgid(argv.gid);
if (argv.uid) process.setgid(argv.uid);

var hyperstream = require('hyperstream');
var ecstatic = require('ecstatic')({
    root: __dirname + '/../static',
    gzip: true
});
var mkdirp = require('mkdirp');

var level = require('level');
var sublevel = require('subleveldown');
var bytewise = require('bytewise');

var dir = {
    data: path.join(argv.home, argv.datadir, 'data'),
    index: path.join(argv.home, argv.datadir, 'index'),
    session: path.join(argv.home, argv.datadir, 'session'),
    blob: path.join(argv.home, argv.datadir, 'blob')
};
mkdirp.sync(dir.blob);

var ixfeed = require('index-feed');
var ixdb = level(dir.index);
var counts = require('../lib/counts.js')(
    sublevel(ixdb, 'c', { valueEncoding: 'json' })
);
var ixf = ixfeed({
    data: level(dir.data),
    index: sublevel(ixdb, 'i'),
    valueEncoding: 'json'
});

ixf.index.add(function (row, cb) {
    if (row.value && row.value.type === 'user') {

        var ix = {
            'user.id': row.value.id,
            'user.name': row.value.name,
            'user.email': row.value.email,
            'user.visibility': row.value.visibility
        };

        var isMember = false;
        var collective, isCollectiveMember, isCollectiveUser;
        var c = {};
        for(collective in settings.collectives) {
            isCollectiveMember = false;
            isCollectiveUser = false;
            ix['user.'+collective] = false;
            ix['member.'+collective] = false;
            if(row.value.collectives && row.value.collectives[collective]) {
                ix['user.'+collective] = true;
                isCollectiveUser = true;
                if(row.value.collectives[collective].privs.indexOf('member') >= 0) {
                    ix['member.'+collective] = true;
                    isMember = true;
                    isCollectiveMember = true;
                    if(row.value.collectives[collective].stripe && row.value.collectives[collective].stripe.customer_id) {
                        ix['user.'+collective+'.stripe_customer_id'] = row.value.collectives[collective].stripe.customer_id;
                    }
                }
            }


            if (!row.prev) {
                c['user.'+collective] = isCollectiveUser ? 1 : 0;
                c['member.'+collective] = isCollectiveMember ? 1 : 0;
            } else {
                if(isCollectiveUser !== row.prev['user.'+collective]) {

                    c['user.'+collective] = isCollectiveUser ? 1 : -1;;
                }
                if(isCollectiveMember !== row.prev['member.'+collective]) {
                    c['member.'+collective] = isCollectiveMember ? 1 : -1;
                }
            }

        }

        ix['user.member'] = isMember;

        if (!row.prev) {
            c['user'] = 1;
            c['member'] = isMember ? 1 : 0;
            
        }
        else if (isMember !== row.prev['user.member']) {
            c['member'] = isMember ? 1 : -1;
        }
        
        if(Object.keys(c).length > 0) {
            counts.add(c, done);
        } else { 
            done()
        }

        function done (err) { cb(err, ix) }
    }
    else cb()
});

var accountdown = require('accountdown');
var users = accountdown(sublevel(ixf.db, 'users'), {
    login: { basic: require('accountdown-basic') }
});

var auth = require('cookie-auth')({
    name: require('../package.json').name,
    sessions: level(dir.session)
});

var store = require('content-addressable-blob-store');
var blob = store({ path: dir.blob });


// run database migration script
if(argv.migrate) {
    var script = require(path.resolve(argv.migrate));
    
    script(users, ixf, counts, blob, argv, settings, function(err) {
        if(err) {
            console.error("Migration script error:", err);
            process.exit(1);
        }
        process.exit(0);
    });

} else {

var fd = alloc(argv.port);

var layout = require('../lib/layout.js')(auth, settings);

var router = require('routes')();
router.addRoute('/', layout('main.html',
    require('../routes/main.js')(ixf, counts, settings)
));
router.addRoute('/c/:collective', layout('collective.html',
    require('../routes/collective.js')(users, ixf, counts, settings)
));
router.addRoute('/account/create', 
    require('../routes/create_account.js')(users, auth, blob, settings)
);

router.addRoute('/account/sign-in', layout('sign_in.html'));
router.addRoute('/account/sign-in/post', 
    require('../routes/sign_in.js')(users, auth, settings)
);

router.addRoute('/account/password-reset', layout('password_reset.html'));
router.addRoute('/account/password-reset-success', layout('password_reset_success.html'));
router.addRoute('/account/password-reset/post', 
    require('../routes/password_reset.js')(users, ixf.index, settings)
);

router.addRoute('/account/sign-out/:token', 
    require('../routes/sign_out.js')(auth, settings)
);

router.addRoute('/admin/c/:collective',
    require('../routes/collective_admin.js')(ixf.index, users, auth, blob, settings)
);

router.addRoute('/admin/u/:username',
    require('../routes/user_admin.js')(ixf.index, users, auth, blob, settings)
);

router.addRoute('/~:name/welcome', 
                require('../routes/welcome.js')(auth, ixf, blob, settings)
);
router.addRoute('/~:name.:ext', require('../routes/ext.js')(ixf, blob));
router.addRoute('/~:name', require('../routes/profile.js')(auth, ixf, blob, settings));
router.addRoute('/~:name/edit',
    require('../routes/edit_profile.js')(users, auth, blob, settings)
);

router.addRoute('/~:name/edit/:collective',
    require('../routes/payment.js')(users, auth, blob, settings)
);


router.addRoute('/c/:collective/members',
    require('../routes/members.js')(users, auth, blob, settings)
);

router.addRoute('/c/:collective/email/users',
    require('../routes/email_list.js')('users', ixf.index, users, settings)
);
router.addRoute('/c/:collective/email/members',
    require('../routes/email_list.js')('members', ixf.index, users, settings)
);

/*
router.addRoute('/admin/dump',
    require('../routes/dump.js')(ixf.index, users)
);
*/

var server = http.createServer(function (req, res) {
    var m = router.match(req.url);
    if (!m) return ecstatic(req, res);
    var rparams = {
        params: m.params,
        error: error
    };
    auth.handle(req, res, function (err, session) {
        rparams.session = session && xtend(session, { update: update });
        m.fn(req, res, rparams);
        
        function update (v, cb) {
            var data = xtend(session, { data: xtend(session.data, v) });
            
            auth.sessions.put(session.session, data, { valueEncoding: 'json' },
            function (err) {
                if (err) cb && cb(err)
                else cb && cb(null)
            });
        }
    });
    
    function error (code, err) {
        res.statusCode = code;
        if (settings.debug) console.log('error: ' + err);
        layout('error.html', function () {
            return hyperstream({ '.error': { _text: err + '\n' } });
        })(req, res, rparams);
    }
});
server.listen({ fd: fd }, function () {
    if(settings.debug) {
        // debug mode will print plaintext passwords to stdout 
        // during account creation and password reset
        // it will however not leak credit card information 
        // since that is never sent to the server (it is only sent to stripe)
        console.log('WARNING: Debug mode enabled. Will leak private user data to stdout (though not credit card info).');
    }
    console.log('listening on :' + server.address().port);
});

}
