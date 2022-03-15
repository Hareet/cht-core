const request = require('request-promise-native');
const RESULT_PARSE_REGEX = /^"(.*)"\n?$/;

// This API gives weird psuedo-JSON results:
//   "password"\n
// Should be just `password`
const parseResponse = response => response.match(RESULT_PARSE_REGEX)[1];

const getCouchNodeName = async () => {
  const serverUrl = getServerUrl();
  const membership = await request.get({ url: `${serverUrl}_membership`, json: true });
  return membership.all_nodes[0];
};

const getServerUrl = () => {
  try {
    const url = new URL(process.env.COUCH_URL);
    url.pathname = '/';
    return url.toString();
  } catch (err) {
    return;
  }
};

const getCredentials = async (key) => {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return Promise.reject(new Error('Failed to find the CouchDB server'));
  }
  const nodeName = await getCouchNodeName();
  if (!nodeName) {
    return Promise.reject(new Error('Failed to find the CouchDB node name'));
  }

  try {
    const response = await request.get(`${serverUrl}_node/${nodeName}/_config/medic-credentials/${key}`);
    return parseResponse(response);
  } catch (err) {
    if (err.statusCode === 404) {
      // no credentials defined
      return;
    }
    throw err;
  }
};

const getCouchConfig = async (param) => {
  const serverUrl = getServerUrl();
  const nodeName = await getCouchNodeName();
  return await request.get({ url: `${serverUrl}_node/${nodeName}/_config/${param}`, json: true });
};

module.exports = {
  getCredentials,
  getCouchConfig,
  getCouchNodeName,
};
