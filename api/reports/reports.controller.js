var Report = require('./../../models/report.model.js');
var mongoose = require('mongoose');
var _ = require('lodash');
var gridfs;
var fs = require('fs');
var Grid = require('gridfs-stream');
var mimetype = require('mimetype');
var events = require('events')
var aws = require('aws-sdk');

Grid.mongo = mongoose.mongo;
var conn = mongoose.createConnection("mongodb://server:nicepassword@ds063870.mongolab.com:63870/road_polizei_uploads");
conn.once('open', function () {
  var gfs = Grid(conn.db);
  gridfs = gfs;
});

function uploadFileToAmazonS3(file) {
    var s3 = new aws.S3({ params : { 
      Bucket : 'roadpolizeidata',
      Key : file.name,
      ContentType : file.mimetype,
      ACL : 'public-read'
    }});
    var body = fs.createReadStream(file.path);
    s3.upload({ Body : body })
      .send(function(err, data) {
        console.log(err);
      });
};


exports.create = function(req, res) {
	var request = req; // in case of closures
	var data = JSON.parse(req.body.JSONMF);
  console.log(data);

  var report = new Report({
    location : { lat : data.geoLocation.latitude, lng : data.geoLocation.longitude},
    carNumber : data.number,
    description : data.violations.join(', '),
    fbId : data.facebookProfile,
    fixationTime : data.timeStamp
  });

  console.log(req.files);
  _.forEach(req.files, function(value, key) {
    var file = value;
    file.mimetype = mimetype.lookup(file.name);
		if (!(file.mimetype.match('image/*') || file.mimetype.match('video/*'))) {
			request.sendStatus(415);
		}
		var obj = {};

    uploadFileToAmazonS3(file); //NEW WTUKA NEEDS TO BE TESTED

		if (gridfs) {
			var fileId = new mongoose.Types.ObjectId();
			obj.gridfsId = fileId;

			var is = fs.createReadStream(file.path);
			var os = gridfs.createWriteStream({
				filename : file.name,
				_id : fileId
			});
			is.pipe(os);
		}

		obj.name = file.name,
		obj.mimetype = file.mimetype,
		obj.size = file.size,

    fs.unlink(file.path); // delete the file from app location

		report.files.push(obj);
	});

	report.save(function(err) {
		if (err) {
			console.log(err);
			res.sendStatus(500);
		} else {
			res.sendStatus(201);
		}
	});
};

exports.getAll = function(req, res) {
  Report.find({}, function(err, reports) {
    if (err) { 
      res.status(404); 
    } else { 
      res.status(200).json(reports);
    }
  })
};

exports.getById = function(req, res) {
  var id = req.params.id;
  Report.findById(id, function(err, report) {
    if (report) {
      res.status(200).json(report);
    } else {
      res.status(404);
    }
  });
};

exports.exportById = function(req, res) {
  var id = req.params.id;
  Report.findOne(
    { _id : id }, 
    //'-_id location deviceId fixationTime recievedTime description fbId files',
     function(err, report) {
      if(report && !err) {
        var files = [];
        _.forEach(report.files, function(file) {
          files.push({
            url       : global.mediaStorageURL + file.name,
            size      : file.size,
            mimetype  : file.mimetype
          });
        });
        report.files = files;
        res.status(200).json(report);
      } else {
        res.status(404);
      }
    });
};

exports.requestTest = function(req, res) {
  var props = [];
  _.forEach(req, function(val, key) {
    props.push(key);
  });
  res.status(201).json({
    body : req.body,
    files : req.files,
    params : req.params,
    query : req.query,
    properties: props
  });
};

exports.getAllShort = function(req, res) {
  Report.find(
    {}, 
    '_id location',
    function(err, reports) {
      var info = [];
      _.forEach(reports, function(report) {
        info.push({
          _id       : report._id,
          location  : report.location,
          exportUrl : global.host + 'api/export/' + report._id
        });
      });
      if (err) { 
        res.status(404); 
      } else { 
        res.status(200).json(info);
      }
  });
};


 function getByDistance(reports, params, callback) {
  var point = { lat : params.lat, lng : params.lng };
  var radius = params.rad;
  
  var rad = function(x) {
    return x * Math.PI / 180;
  };

  var getDistance = function(p1, p2) {
    var R = 6378137; // Earth’s mean radius in meter
    var dLat = rad(p2.lat - p1.lat);
    var dLong = rad(p2.lng - p1.lng);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) *
      Math.sin(dLong / 2) * Math.sin(dLong / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c;
    return d; // returns the distance in meter
  };
  var closeEnough = _.filter(reports, function(report) {
        return getDistance(
          { 
            lat : report.location.lat,
            lng : report.location.lng
          }, point) < radius;
      });
   callback(closeEnough);
};


function makeShort(reports) {
  var res =[];
  _.forEach(reports, function(report) {
    res.push({
      _id       : report._id,
      location  : report.location,
      exportUrl : global.host + 'api/export/' + report._id
    });
  });
  return res;
}

exports.search = function(req, res) {
  var params = req.query;
  var searchObject = {};
  // todo string . contains
  if (params.facebookID !== '') {
    searchObject.fbId = params.facebookID;
  }
  Report.find(searchObject, function(err, reports) {
    if (err) {
      res.status(404);
      console.log('db error');
    } else {
      var filtered = reports;
      if (params.carNumber !== '') {
        filtered = _.filter(filtered, function(report){
          return _.includes(report.carNumber, params.carNumber);
        });
      }
      if (params.description !== '') {
        filtered = _.filter(filtered, function(report) {
          return _.includes(report.description, params.description);
        });
      }
      if (params.fixationTimeStart !== '' && params.fixationTimeEnd !== '') {
          var bounds = { 
           lower : new Date(params.fixationTimeStart),
           upper : new Date(params.fixationTimeEnd)
          };
        //filter by date
        filtered = _.filter(reports, function(report) {
          var time = new Date(report.fixationTime);
          var date = new Date(time.getFullYear(), time.getMonth(), time.getDate());
          var inRange = date > bounds.lower && date < bounds.upper;
          return inRange;
        });
      }

      if (params.lat !== '' 
        && params.lng !== ''
        && params.rad !== '') 
      {
        var p = { lat : params.lat, lng : params.lng, rad : params.rad };
        getByDistance(
          filtered,
          p,
          function(closeEnough) {
            res.status(200).json(makeShort(closeEnough)); 
          });
      } else {
        res.status(200).json(makeShort(filtered));
      }
    }
  })
}

exports.deleteEverything = function(req, res) {
  Report.find({}, function(reports) {
    _.forEach(reports, function(report) {
      _.forEach(reports.files, function(file) {
        fs.unlink(file.fileName);
      });
    });
    reports.remove();

  });
}