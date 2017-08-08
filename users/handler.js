if (!global._babelPolyfill) {
    require('babel-polyfill');
}

import AWS from 'aws-sdk';

import { RxHttpRequest } from 'rx-http-request';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/toArray';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/pluck';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/switchMap';
import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/mapTo';
import 'rxjs/add/operator/mergeAll';
import 'rxjs/add/operator/defaultIfEmpty';

import 'rxjs/add/observable/of';
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/throw';
import 'rxjs/add/observable/if';
import 'rxjs/add/observable/bindNodeCallback';
import 'rxjs/add/observable/forkJoin';

AWS.config.update({
    region: "us-west-2"
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const sns = new AWS.SNS();
const iot = new AWS.Iot();
const sts = new AWS.STS();

const flatten = a => Array.isArray(a) ? [].concat(...a.map(flatten)) : a;

const throwError = (message, name) => {
    throw ({ message: message, name: name });
}

const jsonToUpdateExpression = json => (
        `set ${Object.keys(json).filter(key => json[key] !== null && typeof(json[key]) !== 'undefined').map(key => `${key}=:${key}`).join(',')}`
)

const jsonToExpressionAttributeValues = json => {
    const obj = {};
    Object.keys(json).filter(key => json[key] !== null && typeof(json[key]) !== 'undefined').forEach(key => (obj[`:${key}`] = json[key]))
    return obj;
}

const userByDenaCode$ = (event, context) => (
  Observable.forkJoin(
      Observable.of(event).map(event => JSON.parse(event.body||"{}")),
      Observable.of(event)
  )
  .switchMap(([json, event]) => (
      Observable.bindNodeCallback(docClient.get.bind(docClient))({
          TableName: process.env.DYNAMODB_TABLE,
          Key: { "denaCode": event.pathParameters.denaCode }
      })
  ))
  .pluck('Item')
)

const csfrToken$ = (event, context) => (
  userByDenaCode$(event, context)
  .mergeMap(user => (
    RxHttpRequest.get('http://ffrk.denagames.com/dff/', {
      headers: {
        'Cookie': 'http_session_sid=' + user.denaSessionId
      },
      json: false
    })
    .mergeMap(data => (
      Observable.if(
        () => (!!data.body.match(/FFEnv\.csrfToken="([^"]+)";/)),
        Observable.of(data.body.match(/FFEnv\.csrfToken="([^"]+)";/)[1]).map(csrfToken => ({...user, csrfToken})),
        Observable.throw({
            message: "Invalid Session Id",
            name: "AuthorizationError"
        })
      )
    ))
  ))
)

const partyList$ = (event, context) => (
  sessionKey$(event, context)
  .mergeMap(user => (
    RxHttpRequest.get('http://ffrk.denagames.com/dff/party/list', {
      headers: {
        'Cookie': 'http_session_sid=' + user.denaSessionId,
        'Content-Type': 'application/json',
        'X-CSRF-Token': user.csrfToken,
        'User-Session': user.sessionKey
      },
      json: false
    })
    .pluck('body')
    .map(JSON.parse)
  ))
)

const sessionKey$ = (event, context) => (
  csfrToken$(event, context)
  .mergeMap(user => (
    RxHttpRequest.post('http://ffrk.denagames.com/dff/update_user_session', {
      headers: {
        'Cookie': 'http_session_sid=' + user.denaSessionId,
        'Content-Type': 'application/json',
        'X-CSRF-Token': user.csrfToken
      },
      json: true,
      body: {}
    })
    .pluck('body')
    .map(data => ({...user, sessionKey: data.user_session_key}))
  ))
)

const currentRun$ = (event, context, outputJson) => (
  userByDenaCode$(event, context)
  .mergeMap(user => (
    RxHttpRequest.get('http://ffrk.denagames.com/dff/event/challenge/94/get_battle_init_data', {
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'http_session_sid=' + user.denaSessionId
      },
      json: outputJson
    })
    .mergeMap(response => (
      response.body.match(/DOCTYPE/) ? 
        Observable.bindNodeCallback(docClient.update.bind(docClient))({
            TableName: process.env.DYNAMODB_TABLE,
            Key: { "denaCode": user.denaCode },
            UpdateExpression: jsonToUpdateExpression({hasValidSessionId: 0}),
            ExpressionAttributeValues: jsonToExpressionAttributeValues({hasValidSessionId: 0}),
            ReturnValues: "ALL_NEW"
        }).mapTo(response)
      :
        Observable.of(response).mapTo(response)
     ))
  ))
)


const writeCurrentRunToS3$ = (event, context) => (
  Observable.forkJoin(
    currentRun$(event, context, false)
    .pluck('body')
    .do(runString => (runString.match(/DOCTYPE/) ? throwError("Your Session is Not Valid or Has Expired. Please Log In Again", "SessionError") : {}))
    .map(runString => runString.toString('utf-8').replace(/,"SERVER_TIME":\d+/g,""))
    .catch(err => Observable.of(JSON.stringify(err)))
    ,
    Observable.bindNodeCallback(s3.getObject.bind(s3))({Bucket: process.env.S3_BUCKET, Key: `raw/${event.pathParameters.denaCode}/current-run.json`})
    .catch(err => Observable.of({Body: ""}))
    .map(response => response.Body.toString('utf-8'))
  )
  .do(([currentRun, lastRun]) => (
      currentRun.toString('utf-8').replace(/"created_at":"[^"]",/g,"") !== lastRun.toString('utf-8').replace(/"created_at":"[^"]",/g,"") 
      ? console.log(currentRun.length.toString(), lastRun.length.toString())
      : console.log("duhhhhhh")
  ))
  .mergeMap(([currentRun, lastRun]) => (
      currentRun.toString('utf-8').replace(/"created_at":"[^"]",/g,"") !== lastRun.toString('utf-8').replace(/"created_at":"[^"]",/g,"") 
      ? Observable.bindNodeCallback(s3.putObject.bind(s3))({Bucket: process.env.S3_BUCKET, Key: `raw/${event.pathParameters.denaCode}/current-run.json`, Body: currentRun, ACL: 'public-read'}).map(s3Resp => Observable.of(currentRun))
      : Observable.of(currentRun)
  ))
)

const syndicateRunToSms$ = ([user, run]) => (
  Observable.bindNodeCallback(sns.publish.bind(sns))({
    Message: run.drops.map(drop => `${drop.name} x${drop.num}`).join('\n'),
    MessageStructure: 'string',
    PhoneNumber: user.phone
  })
  .map(([user, run]) => Observable.of([user, run]))
  .catch(() => Observable.of([user, run]))
)


const syndicateRunToDynamo$ = ([user, run]) => (
  Observable.bindNodeCallback(docClient.put.bind(docClient))({
      TableName: process.env.RUNS_DYNAMODB_TABLE,
      Item: run
  })
  .map(([user, run]) => Observable.of([user, run]))
  .catch(() => Observable.of([user, run]))
)

const syndicateRunToIot$ = ([user, run]) => (
  Observable.bindNodeCallback(iot.describeEndpoint.bind(iot))({})
  .pluck('endpointAddress')
  .map(endpoint => new AWS.IotData({ endpoint }))
  .mergeMap(iotData => 
    Observable.bindNodeCallback(iotData.publish.bind(iotData))({
        topic: `ffrkreeper/${user.denaCode}/runs`,
        payload: JSON.stringify(run),
        qos: 0
    })
  )
  .catch(error => {console.log(error); return Observable.of([user, run])})
)




export const iotAuth = (event, context, cb) => {
  const roleName = 'serverless-notifications';
  Observable.bindNodeCallback(iot.describeEndpoint.bind(iot))({})
  .pluck('endpointAddress')
  .map(iotEndpoint => [iotEndpoint, iotEndpoint.replace('.amazonaws.com', '')])
  .map(([iotEndpoint, partial]) => [partial.indexOf('iot'), iotEndpoint, partial])
  .map(([index, iotEndpoint, partial]) => [partial.substring(index + 4), iotEndpoint])
  .mergeMap(([region, iotEndpoint]) => 
    Observable.bindNodeCallback(sts.getCallerIdentity.bind(sts))({})
    .mergeMap(data => Observable.bindNodeCallback(sts.assumeRole.bind(sts))({
      RoleArn: `arn:aws:iam::${data.Account}:role/${roleName}`,
      RoleSessionName: (Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)).toString()
    })
    .map(data => ({
      iotEndpoint,
      region,
      accessKey: data.Credentials.AccessKeyId,
      secretKey: data.Credentials.SecretAccessKey,
      sessionToken: data.Credentials.SessionToken
    })))
  )
  .catch(err => Observable.of(err))
  .subscribe(
      response => cb(null, {body: JSON.stringify(response), statusCode: 200, headers: {'Access-Control-Allow-Origin': '*'}}),
      error => cb({body: JSON.stringify(error), statusCode: 500, headers: {'Access-Control-Allow-Origin': '*'}})
  )

}

export const parseRun = (event, context, cb) => {
  Observable.bindNodeCallback(s3.getObject.bind(s3))({
    Bucket: event.Records[0].s3.bucket.name, 
    Key: event.Records[0].s3.object.key
  })
  .map(response => JSON.parse(response.Body.toString('utf-8')))
  .do(response => !!response.battle ? {} : response.name ? throwError(response.message, response.name) : throwError("You are not in battle. Join a battle to see your drops.", "OutOfBattleError"))
  .mergeMap(json => Observable.forkJoin(
      Observable.of(json.battle.battle_id),
      Observable.of(flatten(json.battle ? [
        json.battle.rounds.map(round => round.drop_item_list),
        json.battle.rounds.map(round => round.enemy.map(enemy => enemy.children.map(child => child.drop_item_list)))
      ] : []))
      .mergeAll()
      .filter(itemJson => !!itemJson.item_id)
      .mergeMap(itemJson => (
        Observable.bindNodeCallback(docClient.get.bind(docClient))({
            TableName: process.env.ITEMS_DYNAMODB_TABLE,
            Key: { "id": parseInt(itemJson.item_id) }
        })
        .pluck('Item')
        .filter(item => !!item)
        .map(item => ({...item, num: itemJson.num}))
      ))
      .toArray()
    )
  )
  .mergeMap(([battle_id, items]) => (
    Observable.bindNodeCallback(s3.putObject.bind(s3))({
      Bucket: process.env.S3_BUCKET, 
      Key: event.Records[0].s3.object.key.replace(/raw/,"processed"), 
      ACL: 'public-read', 
      Body: JSON.stringify({
        created_at: event.Records[0].eventTime,
        drops: items,
        battle_id: parseInt(battle_id),
        user_dena_code: event.Records[0].s3.object.key.split("/")[1]
      })
    })
  ))
  .catch(err => 
    Observable.bindNodeCallback(s3.putObject.bind(s3))({
      Bucket: process.env.S3_BUCKET, 
      Key: event.Records[0].s3.object.key.replace(/raw/,"processed"), 
      ACL: 'public-read', 
      Body: JSON.stringify({
        created_at: event.Records[0].eventTime,
        error: err,
        user_dena_code: event.Records[0].s3.object.key.split("/")[1]
      })
    })
  )
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};




export const syndicateRun = (event, context, cb) => {
  Observable.forkJoin(
    Observable.bindNodeCallback(docClient.get.bind(docClient))({
        TableName: process.env.DYNAMODB_TABLE,
        Key: { "denaCode": event.Records[0].s3.object.key.split("/")[1] }
    })
    .pluck('Item')
    .defaultIfEmpty({}),
    Observable.bindNodeCallback(s3.getObject.bind(s3))({
      Bucket: event.Records[0].s3.bucket.name, 
      Key: event.Records[0].s3.object.key
    })
    .catch(err => Observable.of({}))
    .map(response => response.Body ? JSON.parse(response.Body.toString('utf-8')) : {})
  )
  .mergeMap(([user, run]) => (
    (run.drops||[]).filter(drop => (parseInt(drop.rarity) >= 4)).length > 0 
    ? syndicateRunToSms$([user, run])
    : Observable.of([user, run])
  ))
  .mergeMap(([user, run]) => (
    !run.error 
    ? syndicateRunToDynamo$([user, run])
    : Observable.of([user, run])
  ))
  .mergeMap(([user, run]) => (
    !run.error 
    ? syndicateRunToIot$([user, run])
    : Observable.of([user, run])
  ))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
}


export const parseParty = (event, context, cb) => {
  partyList$(event, context)
  .pluck('materials')
  .mergeMap(material => material)
  .mergeMap(material => (
    Observable.bindNodeCallback(docClient.get.bind(docClient))({
        TableName: process.env.ITEMS_DYNAMODB_TABLE,
        Key: { "id": material.id }
    })
    .catch(e => (
        Observable.bindNodeCallback(docClient.put.bind(docClient))({
            TableName: process.env.ITEMS_DYNAMODB_TABLE,
            Item: material
        })
    ))
    .mapTo(material)
    .mergeMap(item => (
        Observable.if(
            (() => !!item),
            Observable.of(item).map(item => item),
            Observable.bindNodeCallback(docClient.put.bind(docClient))({
                TableName: process.env.ITEMS_DYNAMODB_TABLE,
                Item: material
            }).map(item => item)
        )
    ))
  ))
  .catch(err => ({
    statusCode: 400,
    headers: {
      "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    },
    body: JSON.stringify({
        err,
        input: event,
    })
  }))
  .toArray()
  .map(data => ({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
      },
      body: JSON.stringify({
          data,
          input: event,
      })
  }))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};



export const csfrToken = (event, context, cb) => {
  csfrToken$(event, context)
  .catch(err => ({
    statusCode: 400,
    headers: {
      "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    },
    body: JSON.stringify({
        err,
        input: event,
    })
  }))
  .map(data => ({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
      },
      body: JSON.stringify({
          data,
          input: event,
      })
  }))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};

export const sessionKey = (event, context, cb) => {
  sessionKey$(event, context)
  .catch(err => ({
    statusCode: 400,
    body: JSON.stringify({
        err,
        input: event,
    })
  }))
  .map(data => ({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
      },
      body: JSON.stringify({
          data,
          input: event,
      })
  }))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};

export const partyList = (event, context, cb) => {
  partyList$(event, context)
  .catch(err => ({
    statusCode: 400,
    headers: {
      "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    },
    body: JSON.stringify({
        err,
        input: event,
    })
  }))
  .map(data => ({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
      },
      body: JSON.stringify({
          data,
          input: event,
      })
  }))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};

// export const mainLoop = (event, context, cb) => {
//   Observable.bindNodeCallback(docClient.query.bind(docClient))({
//       TableName: process.env.DYNAMODB_TABLE,
//       IndexName: "UsersByValidSessionIndex",
//       KeyConditionExpression: "hasValidSessionId = :vs",
//       ExpressionAttributeValues: {
//           ":vs": 1
//       }
//   })
//   .pluck("Items")
//   .mergeAll()
//   .mergeMap(user => writeCurrentRunToS3$({pathParameters: {denaCode: user.denaCode}, body: "{}"}, {}))
//   .subscribe(
//       console.log,
//       error => cb(error),
//       () => cb(null, "Done")
//   )
// }

export const index = (event, context, cb) => {
    Observable.bindNodeCallback(docClient.scan.bind(docClient))({ TableName: process.env.DYNAMODB_TABLE })
        .map(data => ({
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
            },
            body: JSON.stringify({
                data,
                input: event,
            })
        }))
        .subscribe(
            response => cb(null, response),
            error => cb(error)
        )
};

export const signin = (event, context, cb) => {
    Observable.forkJoin(
            Observable.of(event).map(event => JSON.parse(event.body)),
            Observable.of(event)
        )
        .switchMap(([json, event]) => (
            Observable.bindNodeCallback(docClient.get.bind(docClient))({
                TableName: process.env.DYNAMODB_TABLE,
                Key: { "denaCode": json.denaCode }
            })
            .catch(e => (
                Observable.bindNodeCallback(docClient.put.bind(docClient))({
                    TableName: process.env.DYNAMODB_TABLE,
                    Item: json
                })
            ))
            .pluck('Item')
            .mergeMap(user => (
                Observable.if(
                    (() => !!user),
                    Observable.of(user).map(user => ({...user, ...json})),
                    Observable.bindNodeCallback(docClient.put.bind(docClient))({
                        TableName: process.env.DYNAMODB_TABLE,
                        Item: json
                    }).map(() => json)
                )
            ))
            .map(user => ({...user, hasValidSessionId: 1}))
            .mergeMap(user => (
                Observable.bindNodeCallback(docClient.update.bind(docClient))({
                    TableName: process.env.DYNAMODB_TABLE,
                    Key: { "denaCode": user.denaCode },
                    UpdateExpression: jsonToUpdateExpression({...user, denaCode: undefined}),
                    ExpressionAttributeValues: jsonToExpressionAttributeValues({...user, denaCode: undefined}),
                    ReturnValues: "ALL_NEW"
                })
            ))
        ))
        .map(data => ({
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
            },
            body: JSON.stringify({
                data,
                input: event,
            })
        }))
        .subscribe(
            response => cb(null, response),
            error => cb(error)
        )
};

export const writeCurrentRunToS3 = (event, context, cb) => {
  writeCurrentRunToS3$(event, context)
  .catch(err => {console.log(err); return ({
    statusCode: 400,
    headers: {
      "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    },
    body: JSON.stringify({
        err,
        input: event,
    })
  })})
  .map(data => ({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
      },
      body: JSON.stringify({
          data,
          input: event,
      })
  }))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};


export const pushDrops = (message, context, cb) => {
  console.log(message)
  // console.log(messageStr.pathParameters)
  // const message = JSON.parse(messageStr);
  console.log(message.pathParameters.denaCode);
  writeCurrentRunToS3$(message, {})
  .switchMap(data => 
    Observable.bindNodeCallback(iot.describeEndpoint.bind(iot))({})
    .pluck('endpointAddress')
    .map(endpoint => new AWS.IotData({ endpoint }))
    .mergeMap(iotData => 
      Observable.bindNodeCallback(iotData.publish.bind(iotData))({
          topic: `ffrkreeper/${message.pathParameters.denaCode}/get-runs`,
          payload: JSON.stringify({message: "OK"}),
          qos: 0
      })
      .catch(console.log)
    )
  )
  .catch(console.log)
  .subscribe(
    () => cb(null, {}),
    err => cb(err)
  )
};



export const currentRun = (event, context, cb) => {
  currentRun$(event, context, true)
  .catch(err => ({
    statusCode: 400,
    headers: {
      "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    },
    body: JSON.stringify({
        err,
        input: event,
    })
  }))
  .map(data => ({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
      },
      body: JSON.stringify({
          data,
          input: event,
      })
  }))
  .subscribe(
      response => cb(null, response),
      error => cb(error)
  )
};

export const signout = (event, context, cb) => { 
    Observable.forkJoin(
            Observable.of(event).map(event => JSON.parse(event.body)),
            Observable.of(event)
        )
        .map(([json, event]) => ([{...json, hasValidSessionId: 0}, event]))
        .switchMap(([json, event]) => (
            Observable.bindNodeCallback(docClient.update.bind(docClient))({
                TableName: process.env.DYNAMODB_TABLE,
                Key: { "denaCode": json.denaCode },
                UpdateExpression: jsonToUpdateExpression({...json, denaCode: undefined}),
                ExpressionAttributeValues: jsonToExpressionAttributeValues({...json, denaCode: undefined}),
                ReturnValues: "ALL_NEW"
            })
        ))
        .map(data => ({
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Origin" : "*", "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
            },
            body: JSON.stringify({
                data,
                input: event,
            })
        }))
        .subscribe(
            response => cb(null, response),
            error => cb(error)
        )
};