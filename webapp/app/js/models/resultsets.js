'use strict';

treeherder.factory('ThResultSetModel', [
    '$rootScope', '$q', '$location', '$interval',
    'thResultSets', 'ThJobModel', 'thEvents',
    'thAggregateIds', 'ThLog', 'thNotify', 'thJobFilters',
    'ThRepositoryModel',
    function(
        $rootScope, $q, $location, $interval, thResultSets,
        ThJobModel, thEvents, thAggregateIds, ThLog, thNotify,
        thJobFilters, ThRepositoryModel) {

    var $log = new ThLog("ThResultSetModel");

   /******
    * Handle updating the resultset datamodel based on a queue of jobs
    * and resultsets.
    *
    * manages:
    *     resultset array
    *     resultset queue
    *     resultset map
    *     job queue
    *     job map
    */

    var defaultResultSetCount = 10;

    // the primary data model
    var repositories = {};

    var updateQueueInterval = 10000;

    var resultSetPollers = {};
    var resultSetPollInterval = 60000;
    var jobPollInterval = 90000;
    var pollDelayMin = 1000;
    var pollDelayMax = 60000;

    // if any of these params are in the url, don't poll for new data
    var noPollingParameters = [
        'fromchange', 'tochange', 'startdate', 'enddate', 'revision'
    ];

    // changes to the url for any of these fields should reload the page
    // because it changes the query to the db
    var reloadOnChangeParameters = [
        'repo',
        'revision',
        'author',
        'fromchange',
        'tochange',
        'startdate',
        'enddate'
    ];

    var registerResultSetPollers = function(){

        if( doResultSetPolling() ){
            // Register resultset poller if it's not registered
            $interval(function(){

                if( (repositories[$rootScope.repoName].resultSets.length > 0) &&
                    (repositories[$rootScope.repoName].loadingStatus.prepending === false) ){

                    thResultSets.getResultSetsFromChange(
                        $rootScope.repoName,
                        repositories[$rootScope.repoName].resultSets[0].revision

                    ).then(function(data){
                        prependResultSets($rootScope.repoName, data.data);
                    });

                } else if( (repositories[$rootScope.repoName].resultSets.length === 0) &&
                           (repositories[$rootScope.repoName].loadingStatus.prepending === false) ){

                    fetchResultSets(
                        $rootScope.repoName, defaultResultSetCount);

                }
            }, resultSetPollInterval);
        }
    };

    var registerJobPollers = function(){

        $interval(function(){

            // The outer interval checks for new resultsets that
            // need a poller registered for job retrieval
            for(var i=0; i < repositories[$rootScope.repoName].resultSets.length; i++){

                var rs = repositories[$rootScope.repoName].resultSets[i];
                if(resultSetPollers[rs.id] === undefined) {

                    /*************************
                      Register new job retrieval poller if not
                      already registered

                      Spread the interval calls out over a min-max interval
                      to avoid all web service http requests hitting
                      simultaneously.

                      Ideally it would be possible to detect when all jobs
                      for a resultset are complete and stop polling for jobs
                      but there is currently no way to do this safely.
                     **************************/
                    var delayInterval = getRandomDelayInterval(
                        pollDelayMin, pollDelayMax);

                    // Make an entry for the poller immediately to
                    // avoid a race with the delayed interval.
                    resultSetPollers[rs.id] = true;

                    _.delay(function(rs){
                        resultSetPollers[rs.id] = $interval(
                            _.bind(updateResultSetJobs, {}, rs, $rootScope.repoName),
                            jobPollInterval);

                    }, delayInterval, rs);
                }
            }
        // Look for new resultsets to register every 5 seconds
        }, 5000);
    };

    var doResultSetPolling = function(){

        var searchObj = $location.search();
        var searchKeys = _.keys(searchObj);

        var keyIntersection = _.intersection(
            noPollingParameters, searchKeys);

        var poll = true;
        if(keyIntersection.length !== 0){
            poll = false;
        }

        return poll;
    };

    var getRandomDelayInterval = function(min, max){
        return parseInt( Math.random() * (max - min) + min );
    };

    var updateResultSetJobs = function(rs, repoName){
        thResultSets.getResultSetJobs({ results:[rs] }, repoName);
    };

    $rootScope.$on(thEvents.mapResultSetJobs, function(ev, repoName, data){

        var i;
        for(i=0; i<repositories[repoName].resultSets.length; i++){

            if(repositories[repoName].resultSets[i].id === data.id){

                _.extend(
                    repositories[repoName].resultSets[i],
                    data );

                mapPlatforms(
                    repoName, repositories[repoName].resultSets[i]);
            }
        }

        $rootScope.$broadcast(thEvents.applyNewJobs, data.id);
    });

    var addRepository = function(repoName){
        //Initialize a new repository in the repositories structure

        // only base the locationSearch on params that are NOT filters,
        // because filters don't effect the server side fetching of
        // jobs.
        var locationSearch = thJobFilters.removeFiltersFromQueryString(
            _.clone($location.search())
        );

        $log.debug("locationSearch", locationSearch);

        if(_.isEmpty(repositories[repoName]) ||
           !_.isEqual(locationSearch, repositories[repoName].search)){
            $log.debug(
                "fetching new resultset list with parameters:",
                locationSearch
                );

            repositories[repoName] = {

                name:repoName,

                lastJobElSelected:{},
                lastJobObjSelected:{},

                // maps to help finding objects to update/add
                rsMap:{},
                jobMap:{},
                unclassifiedFailureMap: {},
                jobMapOldestId:null,
                //used as the offset in paging
                rsMapOldestTimestamp:null,
                resultSets:[],

                // this is "watchable" by the controller now to update its scope.
                loadingStatus: {
                    appending: false,
                    prepending: false
                },
                search: locationSearch
            };

        }
    };

    var getAllShownJobs = function(repoName, maxSize, resultsetId, resultStatusFilters) {
        var shownJobs = [];

        var addIfShown = function(jMap) {
            if (resultsetId && jMap.job_obj.result_set_id !== resultsetId) {
                return;
            }
            if (jMap.job_obj.visible) {
                shownJobs.push(jMap.job_obj);
            }
            if (_.size(shownJobs) === maxSize) {
                thNotify.send("Max size reached.  Using the first " + maxSize,
                              "danger",
                              true);
                return true;
            }
            return false;
        };
        _.detect(getJobMap(repoName), addIfShown);

        return shownJobs;
    };

    var getJobMapKey = function(job) {
        //Build string key for jobMap entires
        return 'key' + job.id;
    };

    var getSelectedJob = function(repoName){
        return { el:repositories[repoName].lastJobElSelected,
                 job:repositories[repoName].lastJobObjSelected };
    };

    var setSelectedJob = function(
        repoName, lastJobElSelected, lastJobObjSelected){

        repositories[repoName].lastJobElSelected = lastJobElSelected;
        repositories[repoName].lastJobObjSelected = lastJobObjSelected;
    };

    var getPlatformKey = function(name, option){
        var key = name;
        if(option !== undefined){
            key += option;
        }
        return key;
    };

    /******
     * Build the Job and Resultset object mappings to make it faster and
     * easier to find and update jobs and resultsets
     *
     * @param data The array of resultsets to map.
     */
    var mapResultSets = function(repoName, data) {

        for (var rs_i = 0; rs_i < data.length; rs_i++) {
            var rs_obj = data[rs_i];
            // make a watch-able revisions array
            rs_obj.revisions = rs_obj.revisions || [];

            var rsMapElement = {
                rs_obj: rs_obj,
                platforms: {}
            };
            repositories[repoName].rsMap[rs_obj.id] = rsMapElement;

            // keep track of the oldest push_timestamp, so we don't auto-fetch resultsets
            // that are out of the range we care about.
            if ( !repositories[repoName].rsMapOldestTimestamp ||
                 (repositories[repoName].rsMapOldestTimestamp > rs_obj.push_timestamp)) {
                repositories[repoName].rsMapOldestTimestamp = rs_obj.push_timestamp;
            }

            // platforms
            if(rs_obj.platforms !== undefined){
                mapPlatforms(repoName, rs_obj);
            }
        }

        $log.debug("sorting", repoName, repositories[repoName]);
        repositories[repoName].resultSets.sort(rsCompare);

        $log.debug("oldest job: ", repositories[repoName].jobMapOldestId);
        $log.debug("oldest result set: ", repositories[repoName].rsMapOldestTimestamp);
        $log.debug("done mapping:", repositories[repoName].rsMap);
    };

    var mapPlatforms = function(repoName, rs_obj){

        for (var pl_i = 0; pl_i < rs_obj.platforms.length; pl_i++) {
            var pl_obj = rs_obj.platforms[pl_i];

            var plMapElement = {
                pl_obj: pl_obj,
                parent: repositories[repoName].rsMap[rs_obj.id],
                groups: {}
            };
            var platformKey = getPlatformKey(pl_obj.name, pl_obj.option);
            repositories[repoName].rsMap[rs_obj.id].platforms[platformKey] = plMapElement;

            // groups
            for (var gp_i = 0; gp_i < pl_obj.groups.length; gp_i++) {
                var gr_obj = pl_obj.groups[gp_i];

                var grMapElement = {
                    grp_obj: gr_obj,
                    parent: plMapElement,
                    jobs: {}
                };
                plMapElement.groups[gr_obj.name] = grMapElement;

                // jobs
                for (var j_i = 0; j_i < gr_obj.jobs.length; j_i++) {
                    var job_obj = gr_obj.jobs[j_i];
                    var key = getJobMapKey(job_obj);

                    var jobMapElement = {
                        job_obj: job_obj,
                        parent: grMapElement
                    };
                    grMapElement.jobs[key] = jobMapElement;
                    repositories[repoName].jobMap[key] = jobMapElement;
                    updateUnclassifiedFailureMap(repoName, job_obj);

                    // track oldest job id
                    if (!repositories[repoName].jobMapOldestId ||
                        (repositories[repoName].jobMapOldestId > job_obj.id)) {
                        repositories[repoName].jobMapOldestId = job_obj.id;
                    }
                }
            }
        }
    };

    var updateUnclassifiedFailureMap = function(repoName, job) {
        if (thJobFilters.isJobUnclassifiedFailure(job)) {
            repositories[repoName].unclassifiedFailureMap[job.job_guid] = true;
        } else {
            delete repositories[repoName].unclassifiedFailureMap[job.job_guid];
        }
    };

    var getUnclassifiedFailureCount = function(repoName) {
        if (_.has(repositories, repoName)) {

            return _.size(repositories[repoName].unclassifiedFailureMap) -
                   _.size(thJobFilters.excludedUnclassifiedFailures);

        }
        return 0;
    };

    /**
     * Sort the resultsets in place after updating the array
     */
    var rsCompare = function(rs_a, rs_b) {
        if (rs_a.push_timestamp > rs_b.push_timestamp) {
          return -1;
        }
        if (rs_a.push_timestamp < rs_b.push_timestamp) {
          return 1;
        }
        return 0;
    };

    /******
     * Ensure that the platform for ``newJob`` exists.  Create it if
     * necessary.  Add to the datamodel AND the map
     * @param newJob
     * @returns plMapElement
     */
    var getOrCreatePlatform = function(repoName, newJob) {
        var rsMapElement = repositories[repoName].rsMap[newJob.result_set_id];
        var platformKey = getPlatformKey(newJob.platform, newJob.platform_option);
        var plMapElement = rsMapElement.platforms[platformKey];
        if (!plMapElement) {

            // this platform wasn't in the resultset, so add it.
            $log.debug("adding new platform");

            var pl_obj = {
                name: newJob.platform,
                option: newJob.platform_option,
                groups: []
            };

            // add the new platform to the datamodel and resort
            if(rsMapElement.rs_obj.hasOwnProperty('platforms')){
                rsMapElement.rs_obj.platforms.push(pl_obj);

                // add the new platform to the resultset map
                rsMapElement.platforms[platformKey] = {
                    pl_obj: pl_obj,
                    parent: rsMapElement,
                    groups: {}
                };
                plMapElement = rsMapElement.platforms[platformKey];
            }
        }
        return plMapElement;
    };

    /******
     * Ensure that the group and platform for ``newJob`` exist.
     * Create it if necessary.  Add to the datamodel AND the map
     * @param newJob
     * @returns grpMapElement
     */
    var getOrCreateGroup = function(repoName, newJob) {
        var plMapElement = getOrCreatePlatform(repoName, newJob);

        if(plMapElement){

            var grMapElement = plMapElement.groups[newJob.job_group_name];
            if (!grMapElement) {
                $log.debug("adding new group");
                var grp_obj = {
                    symbol: newJob.job_group_symbol,
                    name: newJob.job_group_name,
                    jobs: []
                };

                // add the new group to the datamodel
                plMapElement.pl_obj.groups.push(grp_obj);

                // add the new group to the platform map
                plMapElement.groups[grp_obj.name] = {
                    grp_obj: grp_obj,
                    parent: plMapElement,
                    jobs: {}
                };

                grMapElement = plMapElement.groups[newJob.job_group_name];
            }
        }
        return grMapElement;
    };

    /**
     * Fetch the job objects for the ids in ``jobFetchList`` and update them
     * in the data model.
     */
    var fetchJobs = function(repoName, jobFetchList) {
        $log.debug("fetchJobs", repoName, jobFetchList);

        // we could potentially have very large lists of jobs.  So we need
        // to chunk this fetching.
        var count = 40;
        var error_callback = function(data) {
            $log.error("Error fetching jobs: " + data);
        };
        var unavailableJobs = [];
        while (jobFetchList.length > 0) {
            var jobFetchSlice = jobFetchList.splice(0, count);
            ThJobModel.get_list(repoName, {
                job_guid__in: jobFetchSlice.join(),
                count: count
            })
            .then(function(jobsFetched){
                // if there are jobs unfetched, enqueue them for the next run
                var guids_fetched = _.pluck(jobsFetched, "job_guid");
                var guids_unfetched = _.difference(jobFetchSlice, guids_fetched);
                if(guids_unfetched.length > 0){
                    $log.debug("re-adding " +
                        guids_unfetched.length + "job to the fetch queue");
                    unavailableJobs.push.apply(unavailableJobs, guids_unfetched);
                }
                return jobsFetched;
            },error_callback)
            .then(_.bind(updateJobs, $rootScope, repoName));
        }
        // retry to fetch the unfetched jobs later
        _.delay(fetchJobs, 10000, repoName, unavailableJobs);

    };

    var aggregateJobPlatform = function(repoName, job, platformData){

        var resultsetId, platformName, platformOption, platformAggregateId,
            platformKey, jobUpdated, resultsetAggregateId, revision,
            jobGroups;

        jobUpdated = updateJob(repoName, job);

        //the job was not updated or added to the model, don't include it
        //in the jobsLoaded broadcast
        if(jobUpdated === false){
            return;
        }

        resultsetId = job.result_set_id;
        platformName = job.platform;
        platformOption = job.platform_option;

        if(_.isEmpty(repositories[repoName].rsMap[ resultsetId ])){
            //We don't have this resultset
            return;
        }

        platformAggregateId = thAggregateIds.getPlatformRowId(
            repoName,
            job.result_set_id,
            job.platform,
            job.platform_option
            );

        if(!platformData[platformAggregateId]){

            if(!_.isEmpty(repositories[repoName].rsMap[resultsetId])){

                revision = repositories[repoName].rsMap[resultsetId].rs_obj.revision;

                resultsetAggregateId = thAggregateIds.getResultsetTableId(
                    $rootScope.repoName, resultsetId, revision
                    );

                platformKey = getPlatformKey(platformName, platformOption);

                $log.debug("aggregateJobPlatform", repoName, resultsetId, platformKey, repositories);

                jobGroups = [];
                if(repositories[repoName].rsMap[resultsetId].platforms[platformKey] !== undefined){
                    jobGroups = repositories[repoName].rsMap[resultsetId].platforms[platformKey].pl_obj.groups;
                }

                platformData[platformAggregateId] = {
                    platformName:platformName,
                    revision:revision,
                    platformOrder:repositories[repoName].rsMap[resultsetId].rs_obj.platforms,
                    resultsetId:resultsetId,
                    resultsetAggregateId:resultsetAggregateId,
                    platformOption:platformOption,
                    jobGroups:jobGroups,
                    jobs:[]
                };
            }
        }

        platformData[platformAggregateId].jobs.push(job);
    };

    /***
     * update resultsets and jobs with those that were in the update queue
     * @param jobList List of jobs to be placed in the data model and maps
     */
    var updateJobs = function(repoName, jobList) {

        $log.debug("number of jobs returned for add/update: ", jobList.length);

        var platformData = {};

        var jobUpdated, i;

        for (i = 0; i < jobList.length; i++) {
            aggregateJobPlatform(repoName, jobList[i], platformData);
        }

        if(!_.isEmpty(platformData) && repoName === $rootScope.repoName){
            $rootScope.$broadcast(thEvents.jobsLoaded, platformData);
        }
    };

    /******
     *
     * Add or update a new job.  Either we have it loaded already and the
     * status and info need to be updated.  Or we have the resultset, and
     * the job needs to be added to that resultset.
     *
     * Check the map, and update.  or add by finding the right place.
     *
     * Shape of the rsMap:
     * -------------------
     * rsMap = {
           <rs_id1>: {
               rs_obj: rs_obj,
               platforms: {
                   <pl_name1 + pl_option>: {
                       pl_obj: pl_obj,
                       groups: {
                           <grp_name1>: {
                               grp_obj: grp_obj
                           },
                           <grp_name2>: {...}
                       }
                   },
                   <pl_name2>: {...}
               },
           <rs_id2>: {...}
           }
       }
     *
     *
     * @param newJob The new job object that was just fetched which needs
     *               to be added or updated.
     */
    var updateJob = function(repoName, newJob) {

        var key = getJobMapKey(newJob);
        var loadedJobMap = repositories[repoName].jobMap[key];
        var loadedJob = loadedJobMap? loadedJobMap.job_obj: null;
        var rsMapElement = repositories[repoName].rsMap[newJob.result_set_id];

        //We don't have this resultset id yet
        if (_.isEmpty(rsMapElement)) {
            return false;
        }

        if (loadedJob) {
            $log.debug("updating existing job", loadedJob, newJob);
            _.extend(loadedJob, newJob);
        } else {
            // this job is not yet in the model or the map.  add it to both
            $log.debug("adding new job", newJob);

            var grpMapElement = getOrCreateGroup(repoName, newJob);

            if(grpMapElement){

                // add the job mapping to the group
                grpMapElement.jobs[key] = {
                    job_obj: newJob,
                    parent: grpMapElement
                };
                // add the job to the datamodel
                grpMapElement.grp_obj.jobs.push(newJob);

                // add job to the jobmap
                var jobMapElement = {
                    job_obj: newJob,
                    parent: grpMapElement
                };
                repositories[repoName].jobMap[key] = jobMapElement;

            }
        }

        updateUnclassifiedFailureMap(repoName, newJob);

        return true;
    };

    var prependResultSets = function(repoName, data) {
        // prepend the resultsets because they'll be newer.
        var added = [];
        for (var i = data.results.length - 1; i > -1; i--) {
            if (data.results[i].push_timestamp >= repositories[repoName].rsMapOldestTimestamp &&
                isInResultSetRange(repoName, data.results[i].push_timestamp) &&
                repositories[repoName].rsMap[data.results[i].id] === undefined) {

                $log.debug("prepending resultset: ", data.results[i].id);
                repositories[repoName].resultSets.push(data.results[i]);
                added.push(data.results[i]);
            } else {
                $log.debug("not prepending.  timestamp is older");
            }
        }

        mapResultSets(repoName, added);

        repositories[repoName].loadingStatus.prepending = false;
    };

    var appendResultSets = function(repoName, data) {

        if(data.results.length > 0){

            $log.debug("appendResultSets", data.results);
            var rsIds = _.map(repositories[repoName].resultSets, function(rs){
                return rs.id;
            });

            // ensure we only append resultsets we don't already have.
            // There could be overlap with fetching "next 10" because we use
            // the latest ``push_timestamp`` and theoretically we could
            // get
            var newResultsets = [];
            _.each(data.results, function(rs) {
                if (!_.contains(rsIds, rs.id)) {
                    newResultsets.push(rs);
                }
            });

            Array.prototype.push.apply(
                repositories[repoName].resultSets, newResultsets
            );
            mapResultSets(repoName, newResultsets);

            // only set the meta-data on the first pull for a repo.
            // because this will establish ranges from then-on for auto-updates.
            if (_.isUndefined(repositories[repoName].meta)) {
                repositories[repoName].meta = data.meta;
            }
        }

        repositories[repoName].loadingStatus.appending = false;
    };

    /**
     * Ensure the revisions for this resultset have been loaded.  If this resultset
     * already has revisions loaded, then this is a no-op.
     */
    var loadRevisions = function(repoName, resultsetId){
        $log.debug("loadRevisions", repoName, resultsetId);
        var rs = repositories[repoName].rsMap[resultsetId].rs_obj;
        if (rs && rs.revisions.length === 0) {
            $log.debug("loadRevisions: check out to load revisions", rs, repoName);
            // these revisions have never been loaded; do so now.
            return thResultSets.get(rs.revisions_uri).
                success(function(data) {

                    if (rs.revisions.length === 0) {
                        Array.prototype.push.apply(rs.revisions, data);
                        $rootScope.$broadcast(thEvents.revisionsLoaded, rs);
                    }

                });
        }
    };

    /**
     * Check if ``repoName`` had a range specified in its ``meta`` data
     * and whether or not ``push_timestamp`` falls within that range.
     */
    var isInResultSetRange = function(repoName, push_timestamp) {
        var result = true;
        if (repositories[repoName] && repositories[repoName].length) {
            var meta = repositories[repoName].meta;
            if (_.has(meta, "push_timestamp__gte") &&
                push_timestamp < meta.push_timestamp__gte) {
                result = false;
            }
            if (_.has(meta, "push_timestamp__lte") &&
                push_timestamp > meta.push_timestamp__lte) {
                result = false;
            }
            if (_.has(meta, "push_timestamp__lt") &&
                push_timestamp >= meta.push_timestamp__lt) {
                result = false;
            }
        }

        return result;
    };

    var getResultSetsArray = function(repoName){
        // this is "watchable" for when we add new resultsets and have to
        // sort them
        return repositories[repoName].resultSets;
    };

    var getResultSetsMap = function(repoName){
        return repositories[repoName].rsMap;
    };

    var getResultSet = function(repoName, resultsetId){
        return repositories[repoName].rsMap[resultsetId].rs_obj;
    };

    var getJobMap = function(repoName){
        // this is a "watchable" for jobs
        return repositories[repoName].jobMap;
    };
    var getLoadingStatus = function(repoName){
        return repositories[repoName].loadingStatus;
    };
    var isNotLoaded = function(repoName){
        return _.isEmpty(repositories[repoName].rsMap);
    };

    var fetchResultSets = function(repoName, count, keepFilters){
        /**
         * Get the next batch of resultsets based on our current offset.
         * @param count How many to fetch
         */
        repositories[repoName].loadingStatus.appending = true;
        var resultsets;
        var loadRepositories = ThRepositoryModel.load(repoName);
        var loadResultsets = thResultSets.getResultSets(repoName,
                                       repositories[repoName].rsMapOldestTimestamp,
                                       count,
                                       undefined,
                                       false,
                                       true,
                                       keepFilters).
            then(function(data) {
                resultsets = data.data;
            });

        $q.all([loadRepositories, loadResultsets]).
            then(
                function() {
                    appendResultSets(repoName, resultsets);
                },
                function(data) {
                    thNotify.send("Error retrieving job data!", "danger", true);
                    $log.error(data);
                    appendResultSets(repoName, {results: []});
                }).
            then(function(){
                thResultSets.getResultSetJobs(resultsets, repoName);
            });
    };

    //Public interface
    var api = {

        addRepository: addRepository,
        aggregateJobPlatform: aggregateJobPlatform,
        fetchJobs: fetchJobs,
        fetchResultSets: fetchResultSets,
        getAllShownJobs: getAllShownJobs,
        getJobMap: getJobMap,
        getLoadingStatus: getLoadingStatus,
        getPlatformKey: getPlatformKey,
        getResultSet: getResultSet,
        getResultSetsArray: getResultSetsArray,
        getResultSetsMap: getResultSetsMap,
        getSelectedJob: getSelectedJob,
        getUnclassifiedFailureCount: getUnclassifiedFailureCount,
        isNotLoaded: isNotLoaded,
        loadRevisions: loadRevisions,
        setSelectedJob: setSelectedJob,
        updateUnclassifiedFailureMap: updateUnclassifiedFailureMap,
        defaultResultSetCount: defaultResultSetCount,
        reloadOnChangeParameters: reloadOnChangeParameters

    };

    registerResultSetPollers();
    registerJobPollers();

    return api;

}]);
