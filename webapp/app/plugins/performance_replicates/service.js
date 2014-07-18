"use strict";

treeherder.service('PerformanceReplicates',
        ['ThPerformanceArtifactModel',
        function (ThPerformanceArtifactModel) {

    this.data = [];

    this.load_replicates = function (series_signature, job_id) {
        var _this = this;

        ThPerformanceArtifactModel.get_list({
            series_signature: series_signature,
            job_id: job_id
        }).then(function (ret) {
            if (!angular.isArray(ret) || !ret[0].blob) return [];
            var blob = JSON.parse(ret[0].blob);

            _this.data = blob.blob.replicates;
        });
    };
}]);
