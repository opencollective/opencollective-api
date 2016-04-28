module.exports = imageUrlToAmazonUrl;
var path = require('path');
var uuid = require('node-uuid');
var mime = require('mime');
var request = require('request');

/**
* Takes an external image URL and returns a Amazon S3 URL with the 
* same file.
*
* @param knox_client {Client} Knox `Client` instance e.g `app.knox`
* @param src {String}
* @param callback {Function}
* 		@param error {Error|null}
* 		@param aws_src {String}
*/
function imageUrlToAmazonUrl(knox_client, src, callback)
{
	var options = {url: src, method: 'HEAD'};
	request(options, (error, response) => {
		if (error) return callback(error)
		var contentLength = response.headers['content-length'];
		var contentType = response.headers['content-type'];
		if (contentLength)
		{
			var name = path.basename(src).replace(/\W/g, ''); // remove non alphanumeric
			var ext = mime.extension(contentType) || path.extname(src);
			var filename = ['/', name, '_', uuid.v1(), '.', ext].join('');

			var put = knox_client.put(filename, {
				'Content-Length': contentLength,
				'Content-Type': contentType,
				'x-amz-acl': 'public-read'
			});

			// stream in and out to s3
			request.get(src).pipe(put);

			put.on('response', () => {
				setImmediate(callback, put.url ? null : new Error('Upload Failed - s3 URL was not created'), put.url);
			});
		}
		else
		{
			callback(new Error('Not found - header missing content-length'));
		}
	});
}

// @example
// 
// imageUrlToAmazonUrl(
//	app.knox,
// 	'http://avatars0.githubusercontent.com/u/13403593?v=3&s=200',
// 	function(error, aws_src)
// 	{
// 		if (error) throw error
// 		console.log('s3 src', aws_src);
// 	}
// )
