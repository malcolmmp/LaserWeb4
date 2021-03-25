var webpack = require('webpack');
var path = require('path');

var src_path = path.resolve('./src');
var dist_path = path.resolve('./dist');

module.exports = {
    context: src_path,
    entry: [
        'babel-polyfill', './index.js'
    ],
    output: {
        path: dist_path,
        filename: 'index.js'
    },
    node: { "fs": "empty" },
    module: {
        loaders: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                loader: 'babel-loader',
                query: {
                    presets: ['react'],
                    plugins: ['transform-es2015-destructuring', 'transform-es2015-parameters', 'transform-object-rest-spread', 'transform-es2015-modules-commonjs', 'react-hot-loader/babel']
                }
            }, {
                test: /\.css$/,
                loader: 'style-loader!css-loader'
            }, {
                test: /\.png$/,
                loader: 'url-loader?limit=100000'
            }, {
                test: /\.jpg$/,
                loader: 'file-loader'
            }, {
                test: /\.(woff|woff2)(\?v=\d+\.\d+\.\d+)?$/,
                loader: 'url-loader?limit=10000&mimetype=application/font-woff'
            }, {
                test: /\.ttf(\?v=\d+\.\d+\.\d+)?$/,
                loader: 'url-loader?limit=10000&mimetype=application/octet-stream'
            }, {
                test: /\.eot(\?v=\d+\.\d+\.\d+)?$/,
                loader: 'file-loader'
            }, {
                test: /\.svg(\?v=\d+\.\d+\.\d+)?$/,
                loader: 'url-loader?limit=10000&mimetype=image/svg+xml'
            }, {
                test: /\.json$/,
                loader: 'json-loader'
            }, {
                test: /\.wasm$/,
                loader: "file-loader",
                options: {
                    publicPath: "dist/"
                }
            }, {
                test: /\.md$/,
                loader: "markdown-loader"
            }, {
                test: /\.swf$/,
                loader: "file-loader?name=[path][name].[ext]"
            }, {
                test: require.resolve('snapsvg'),
                loader: 'imports-loader?this=>window,fix=>module.exports=0'
            },
        ]
    },
    plugins: [
        new webpack.ProvidePlugin({$: 'jquery', jQuery: 'jquery'}),
        new webpack.HotModuleReplacementPlugin(),
    ],
    devtool: 'source-map'
};
