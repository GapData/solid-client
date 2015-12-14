var Solid = Solid || {};

// LDP operations
Solid.web = (function(window) {
    'use strict';

    // Init some defaults;
    var PROXY = "https://databox.me/proxy?uri={uri}";
    var TIMEOUT = 5000;

    $rdf.Fetcher.crossSiteProxyTemplate = PROXY;
    // common vocabs
    var RDF = $rdf.Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#");
    var RDFS = $rdf.Namespace("http://www.w3.org/2000/01/rdf-schema#");
    var FOAF = $rdf.Namespace("http://xmlns.com/foaf/0.1/");
    var OWL = $rdf.Namespace("http://www.w3.org/2002/07/owl#");
    var PIM = $rdf.Namespace("http://www.w3.org/ns/pim/space#");
    var UI = $rdf.Namespace("http://www.w3.org/ns/ui#");
    var DCT = $rdf.Namespace("http://purl.org/dc/terms/");
    var LDP = $rdf.Namespace("http://www.w3.org/ns/ldp#");

    // return metadata for a given request
    var parseResponseMeta = function(resp) {
        var h = Solid.utils.parseLinkHeader(resp.getResponseHeader('Link'));
        var meta = {};
        meta.url = resp.getResponseHeader('Location');
        meta.acl = h['acl'];
        meta.meta = (h['meta'])?h['meta']:h['describedBy'];
        meta.user = (resp.getResponseHeader('User'))?resp.getResponseHeader('User'):'';
        meta.exists = false;
        meta.err = null;
        if (resp.status === 200) {
            meta.exists = true;
        } else if (resp.status >= 500) {
            meta.err = {
                status: 500,
                body: resp.responseText
            };
        }
        return meta;
    };

    // check if a resource exists and return useful Solid info (acl, meta, type, etc)
    // resolve(metaObj)
    var head = function(url) {
        var promise = new Promise(function(resolve) {
            var http = new XMLHttpRequest();
            http.open('HEAD', url);
            http.onreadystatechange = function() {
                if (this.readyState == this.DONE) {
                    resolve(parseResponseMeta(this));
                }
            };
            http.send();
        });

        return promise;
    };

    // fetch an RDF resource
    // resolve(graph) | reject(this)
    var get = function(url) {
        var promise = new Promise(function(resolve, reject) {
            var g = new $rdf.graph();
            var f = new $rdf.fetcher(g, TIMEOUT);

            var docURI = (url.indexOf('#') >= 0)?url.slice(0, url.indexOf('#')):url;
            f.nowOrWhenFetched(docURI,undefined,function(ok, body, xhr) {
                if (!ok) {
                    reject({ok: ok, status: xhr.status, body: body, xhr: xhr, g: g});
                } else {
                    resolve(g);
                }
            });
        });

        return promise;
    };

    // create new resource
    // resolve(metaObj) | reject
    var post = function(url, slug, data, isContainer) {
        var resType = (isContainer)?'http://www.w3.org/ns/ldp#BasicContainer':'http://www.w3.org/ns/ldp#Resource';
        var promise = new Promise(function(resolve, reject) {
            var http = new XMLHttpRequest();
            http.open('POST', url);
            http.setRequestHeader('Content-Type', 'text/turtle');
            http.setRequestHeader('Link', '<'+resType+'>; rel="type"');
            if (slug && slug.length > 0) {
                http.setRequestHeader('Slug', slug);
            }
            http.withCredentials = true;
            http.onreadystatechange = function() {
                if (this.readyState == this.DONE) {
                    if (this.status === 200 || this.status === 201) {
                        resolve(parseResponseMeta(this));
                    } else {
                        reject(this);
                    }
                }
            };
            if (data) {
                http.send(data);
            } else {
                http.send();
            }
        });

        return promise;
    };

    // update/create resource using HTTP PUT
    // resolve(metaObj) | reject
    var put = function(url, data) {
        var promise = new Promise(function(resolve, reject) {
            var http = new XMLHttpRequest();
            http.open('PUT', url);
            http.setRequestHeader('Content-Type', 'text/turtle');
            http.withCredentials = true;
            http.onreadystatechange = function() {
                if (this.readyState == this.DONE) {
                    if (this.status === 200 || this.status === 201) {
                        return resolve(parseResponseMeta(this));
                    } else {
                        reject(this);
                    }
                }
            };
            if (data) {
                http.send(data);
            } else {
                http.send();
            }
        });

        return promise;
    };

    // delete a resource
    // resolve(true) | reject
    var del = function(url) {
        var promise = new Promise(function(resolve, reject) {
            var http = new XMLHttpRequest();
            http.open('DELETE', url);
            http.withCredentials = true;
            http.onreadystatechange = function() {
                if (this.readyState == this.DONE) {
                    if (this.status === 200) {
                        return resolve(true);
                    } else {
                        reject(this);
                    }
                }
            };
            http.send();
        });

        return promise;
    }

    // return public methods
    return {
        head: head,
        get: get,
        post: post,
        put: put,
        del: del,
    };
}(this));

// Identity / WebID
Solid.identity = (function(window) {
    'use strict';

    // Init some defaults;
    var PROXY = "https://databox.me/proxy?uri={uri}";
    var TIMEOUT = 5000;

    $rdf.Fetcher.crossSiteProxyTemplate = PROXY;
    // common vocabs
    var OWL = $rdf.Namespace("http://www.w3.org/2002/07/owl#");
    var PIM = $rdf.Namespace("http://www.w3.org/ns/pim/space#");
    var FOAF = $rdf.Namespace("http://xmlns.com/foaf/0.1/");

    // fetch user profile (follow sameAs links) and return promise with a graph
    // resolve(graph)
    var getProfile = function(url) {
        var promise = new Promise(function(resolve) {
            // Load main profile
            Solid.web.get(url).then(
                function(graph) {
                    // set WebID
                    var webid = graph.any($rdf.sym(url), FOAF('primaryTopic'));
                    // find additional resources to load
                    var sameAs = graph.statementsMatching(webid, OWL('sameAs'), undefined);
                    var seeAlso = graph.statementsMatching(webid, OWL('seeAlso'), undefined);
                    var prefs = graph.statementsMatching(webid, PIM('preferencesFile'), undefined);
                    var toLoad = sameAs.length + seeAlso.length + prefs.length;

                    var checkAll = function() {
                        if (toLoad === 0) {
                            return resolve(graph);
                        }
                    }
                    // Load sameAs files
                    if (sameAs.length > 0) {
                        sameAs.forEach(function(same){
                            Solid.web.get(same.object.value, same.object.value).then(
                                function(g) {
                                    Solid.utils.appendGraph(graph, g);
                                    toLoad--;
                                    checkAll();
                                }
                            ).catch(
                            function(err){
                                console.log(err);
                                toLoad--;
                                checkAll();
                            });
                        });
                    }
                    // Load seeAlso files
                    if (seeAlso.length > 0) {
                        seeAlso.forEach(function(see){
                            Solid.web.get(see.object.value).then(
                                function(g) {
                                    Solid.utils.appendGraph(graph, g, see.object.value);
                                    toLoad--;
                                    checkAll();
                                }
                            ).catch(
                            function(err){
                                console.log(err);
                                toLoad--;
                                checkAll();
                            });
                        });
                    }
                    // Load preferences files
                    if (prefs.length > 0) {
                        prefs.forEach(function(pref){
                            Solid.web.get(pref.object.value).then(
                                function(g) {
                                    Solid.utils.appendGraph(graph, g, pref.object.value);
                                    toLoad--;
                                    checkAll();
                                }
                            ).catch(
                            function(err){
                                console.log(err);
                                toLoad--;
                                checkAll();
                            });
                        });
                    }
                }
            )
            .catch(
                function(err) {
                    console.log("Could not load",url);
                    resolve(err);
                }
            );
        });

        return promise;
    };

    // Find the user's workspaces
    var getWorkspaces = function(webid, graph) {
        var promise = new Promise(function(resolve, reject){
            if (!graph) {
                // fetch profile
                getProfile(webid).then(function(g) {
                    return getWorkspaces(webid, g);
                }).catch(function(err){
                    reject(err);
                });
            } else {
                // find workspaces
                console.log(graph);
            }
        });

        return promise;
    };

    // return public methods
    return {
        getProfile: getProfile,
        getWorkspaces: getWorkspaces
    };
}(this));

Solid.auth = (function(window) {
    'use strict';

   // default (preferred) authentication endpoint
    var authEndpoint = 'https://databox.me/';
    var signupEndpoint = 'https://solid.github.io/solid-idps/';

    // return the current user's WebID from the User header if authenticated
    // resolve(string)
    var withWebID = function(url) {
        url = url || window.location.origin+window.location.pathname;
        var promise = new Promise(function(resolve, reject) {
            var http = new XMLHttpRequest();
            http.open('HEAD', url);
            http.withCredentials = true;
            http.onreadystatechange = function() {
                if (this.readyState == this.DONE) {
                    if (this.status === 200) {
                        var user = this.getResponseHeader('User');
                        if (user && user.length > 0 && user.slice(0, 4) == 'http') {
                            return resolve(user);
                        }
                    }
                    // authenticate to a known endpoint
                    var http = new XMLHttpRequest();
                    http.open('HEAD', authEndpoint);
                    http.withCredentials = true;
                    http.onreadystatechange = function() {
                        if (this.readyState == this.DONE) {
                            if (this.status === 200) {
                                var user = this.getResponseHeader('User');
                                if (user && user.length > 0 && user.slice(0, 4) == 'http') {
                                    return resolve(user);
                                }
                            }
                            return reject({ok: false, status: this.status, body: this.responseText, xhr: this});
                        }
                    };
                    http.send();
                }
            };
            http.send();
        });

        return promise;
    };

    // Open signup window
    var signup = function(url) {
        url = url || signupEndpoint;
        var leftPosition, topPosition;
        var width = 1024;
        var height = 600;
        // set borders
        leftPosition = (window.screen.width / 2) - ((width / 2) + 10);
        // set title and status bars
        topPosition = (window.screen.height / 2) - ((height / 2) + 50);
        window.open(url+"?origin="+encodeURIComponent(window.location.origin), "Solid signup", "resizable,scrollbars,status,width="+width+",height="+height+",left="+ leftPosition + ",top=" + topPosition);

        var promise = new Promise(function(resolve, reject) {
            console.log("Starting listener");
            listen().then(function(webid) {
                return resolve(webid);
            }).catch(function(err){
                return reject(err);
            });
        });

        return promise;
    };

    // Listen to login messages from child window/iframe
    var listen = function() {
        var promise = new Promise(function(resolve, reject){
            console.log("In listen()");
            var eventMethod = window.addEventListener ? "addEventListener" : "attachEvent";
            var eventListener = window[eventMethod];
            var messageEvent = eventMethod == "attachEvent" ? "onmessage" : "message";
            eventListener(messageEvent,function(e) {
                var u = e.data;
                if (u.slice(0,5) == 'User:') {
                    var user = u.slice(5, u.length);
                    if (user && user.length > 0 && user.slice(0,4) == 'http') {
                        return resolve(user);
                    } else {
                        return reject(user);
                    }
                }
            },true);
        });

        return promise;
    };

    // return public methods
    return {
        withWebID: withWebID,
        signup: signup,
        listen: listen,
    };
}(this));

// Events
Solid.status = (function(window) {
    'use strict';

    // Get current online status
    var isOnline = function() {
        return window.navigator.onLine;
    };

    // Is offline
    var onOffline = function(callback) {
        window.addEventListener("offline", callback, false);
    };
    // Is online
    var onOnline = function(callback) {
        window.addEventListener("online", callback, false);
    };

    // return public methods
    return {
        isOnline: isOnline,
        onOffline: onOffline,
        onOnline: onOnline,
    };
}(this));


// --------------- Helper functions ---------------
Solid.utils = (function(window) {
    'use strict';

    // parse a Link header
    var parseLinkHeader = function(link) {
        var linkexp = /<[^>]*>\s*(\s*;\s*[^\(\)<>@,;:"\/\[\]\?={} \t]+=(([^\(\)<>@,;:"\/\[\]\?={} \t]+)|("[^"]*")))*(,|$)/g;
        var paramexp = /[^\(\)<>@,;:"\/\[\]\?={} \t]+=(([^\(\)<>@,;:"\/\[\]\?={} \t]+)|("[^"]*"))/g;

        var matches = link.match(linkexp);
        var rels = {};
        for (var i = 0; i < matches.length; i++) {
            var split = matches[i].split('>');
            var href = split[0].substring(1);
            var ps = split[1];
            var s = ps.match(paramexp);
            for (var j = 0; j < s.length; j++) {
                var p = s[j];
                var paramsplit = p.split('=');
                var name = paramsplit[0];
                var rel = paramsplit[1].replace(/["']/g, '');
                rels[rel] = href;
            }
        }
        return rels;
    };

    // append statements from one graph object to another
    var appendGraph = function(toGraph, fromGraph, docURI) {
        var why = (docURI)?$rdf.sym(docURI):undefined;
        fromGraph.statementsMatching(undefined, undefined, undefined, why).forEach(function(st) {
            toGraph.add(st.subject, st.predicate, st.object, st.why);
        });
    };

    return {
        parseLinkHeader: parseLinkHeader,
        appendGraph: appendGraph,
    };
}(this));