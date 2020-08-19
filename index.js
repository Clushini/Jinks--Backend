const express = require('express');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios').default;
const app = express();
const port = 4000;
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const mongoosastic = require("mongoosastic");
const Schema = mongoose.Schema;
const args = process.argv.slice(2);
const secret = `${args[4]}`;
const saltRounds = 10;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

const mongoURI = `mongodb+srv://${args[0]}:${args[1]}@cluster0.rzq3y.mongodb.net/scraper?retryWrites=true&w=majority`;

mongoose.connect(mongoURI, function(err) {
    if (err) {
        console.log(err);
    }
    console.log("MongoDB Connection Established...");
});

let LinkSchema = new Schema({
    link: {type: String, searchable: true, es_indexed: true},
    data: {type: String, searchable: true, es_indexed: true},
    title: {type: String, searchable: true, es_indexed: true},
    user: {type: String, searchable: true, es_indexed: true},
    date: {type: String, es_indexed: true},
    image: {type: String, es_indexed: true},
    og_description: {type: String, es_indexed: true},
    description: {type: String, es_indexed: true}
})

LinkSchema.index({'$**': 'text'});

LinkSchema.statics = {
    searchPartial: function(q, callback) {
        return this.find({
            $or: [
                { "link": new RegExp(q, "gi") },
                { "data": new RegExp(q, "gi") }
            ]
        }, callback);
    },

    searchFull: function (q, callback) {
        return this.find({
            $text: { $search: q, $caseSensitive: false }
        }, callback)
    },

    search: function(q, callback) {
        this.searchFull(q, (err, data) => {
            if (err) return callback(err, data);
            if (!err && data.length) return callback(err, data);
            if (!err && data.length === 0) return this.searchPartial(q, callback);
        });
    },
}

LinkSchema.plugin(mongoosastic, {
  host: "jinks-9773570650.us-west-2.bonsaisearch.net",
  port: 443,
  protocol: "https",
  auth: `${args[2]}:${args[3]}`
})

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    firstname: { type: String },
    lastname: { type: String }
});

UserSchema.methods.isCorrectPassword = function(password, callback){
    bcrypt.compare(password, this.password, function(err, same) {
      if (err) {
        callback(err);
      } else {
        callback(err, same);
      }
    });
}

UserSchema.pre('save', function(next) {
    // Check if document is new or a new password has been set
    if (this.isNew || this.isModified('password')) {
      // Saving reference to this because of changing scopes
      const document = this;
      bcrypt.hash(document.password, saltRounds,
        function(err, hashedPassword) {
        if (err) {
          next(err);
        }
        else {
          document.password = hashedPassword;
          next();
        }
      });
    } else {
      next();
    }
});

module.exports = mongoose.model('User', UserSchema);
const UserModel = mongoose.model('User', UserSchema);

app.get('/', function (req, res) {
    res.send('Hello World!');
});

app.post('/search', async function(req, res) {
    const term = req.body.searchTerm;
    const token = req.body.token;
    const username = getDecodedFromJwt(token).email;

    console.log(username)

    let mainquery = {
        "bool": {
          "must": {
              "simple_query_string": {
                  "query": `*${term}*`,
                  "fields": [
                      "link^5",
                      "data",
                      "title^5",
                      "time",
                      "image",
                      "og_description^5",
                      "description^5"
                  ],
                  "analyze_wildcard": "true",
                  "default_operator": "AND"
              }
          },
          "filter": {
              "term": {
                  "user": `${String(username).toLowerCase()}`
              }
          }
      }
    }
    
    let queryargs = {

    }
    
    const LinkModel = mongoose.model(`${String(username).toLowerCase()}`, LinkSchema);

    LinkModel.search(mainquery, queryargs, function(err,results) {  
      if (err) {
        console.log(err)
      }
      let resultPackage;
      res.send(results);
    })
});

app.post('/savelink', (req, res) => {

    const link = req.body.link;
    const token = req.body.token;
    const username = getDecodedFromJwt(token).email;
    const LinkModel = mongoose.model(`${String(username).toLowerCase()}`, LinkSchema);

    console.log("request by --");
    console.log(username);
    console.log("request by --");

    if (username) {
      LinkModel.createMapping(function(err, mapping){  
        if(err){
          console.log('error creating mapping (you can safely ignore this)');
        }else{
          console.log('mapping created!');
          console.log(mapping);
        }
      });
  
      LinkModel.on('es-indexed', function(err,res) {
        console.log(err)
        console.log(res)
      })
  
      axios.get(`${link}`)
          .then(function (response) {
              let data = response.data;
              let $ = cheerio.load(data);
  
              let yes = [];
              let title = $("title").text();
              let image = $('meta[property="og:image"]').attr('content');
              let description = $('meta[property="og:description"]').attr('content');
              let description2 = $('meta[name="description"]').attr('content');
              $('*').each(function (i, e) {
                  yes[i] = $(this).text();
              });
              let fixedYes = yes.join(' ');
  
              let ElasticLink = new LinkModel({
                title: title,
                link: link,
                data: fixedYes,
                user: String(username).toLowerCase(),
                date: new Date(),
                image: image,
                og_description: description,
                description: description2
              })
  
              // LinkModel.create({link: test, data: fixedYes, title: title}, function(err) {
              //     if (err) return handleError(err);
              //     res.send(`Link Saved - ${title}`);
              // })
              
              ElasticLink.save(function(err) {
                    if (err) {
                      res.send("FAILED");
                    } else {
                      res.send("OK");
                    }
              })
          })
          .catch(function (error) {
              console.log(error);
          })
    }

    else {
      res.send("UNAUTHORIZED");
    }

});

app.post('/api/register', function(req, res) {
    const { email, password } = req.body;
    const user = new UserModel({ email, password });
    user.save(function(err) {
      if (err) {
        console.log(err)
        res.status(200).send("FAILED");
      } else {
        res.status(200).send("SUCCESS");
      }
    });
});

app.post('/api/authenticate', function(req, res) {
  const { email, password } = req.body;
  UserModel.findOne({ email }, function(err, user) {
    if (err) {
      console.error(err);
      res.send("FAILED")

    } else if (!user) {
      res.send("FAILED")
    } else {
      user.isCorrectPassword(password, function(err, same) {
        if (err) {
          res.send("FAILED")
        } else if (!same) {
          res.send("FAILED")
        } else {
          // Issue token
          const payload = { email };
          const token = jwt.sign(payload, secret, {
            expiresIn: '1h'
          });
          res.status(200).send(token);
        }
      });
    }
  });
});

app.post('/api/isauthorized', function(req, res) {
  console.log(req.body)
  jwt.verify(req.body.token, secret, function(err, decoded) {
    if (err) {
      console.log(err)
      res.status(401).send('Unauthorized: Invalid token');
    } else {
      req.email = decoded.email;
      if (req.email) {
        // console.log("--email")
        // console.log(req.email)
        // console.log("--email")
        res.send("authorized");
      }
    }
  });
})

app.post('/api/getuserdata', function(req, res) {
  let token = req.body.token;
  let username = getDecodedFromJwt(token).email;

  UserModel.findOne({email: username}, function(err, user) {
    if (err) {
      console.log(err);
    }
    if (user) {
      user.password = "HIDDEN";
      res.send(user);
    }
  })
})

app.post('/api/getlinkpreview', function(req, res) {
  let token = req.body.token;
  let username = getDecodedFromJwt(token).email;
  let link = "http://" + req.body.link;

  axios.get(`${link}`)
  .then(function (response) {
      let data = response.data;
      let $ = cheerio.load(data);
      let title = $("title").text();
      let image = $('meta[property="og:image"]').attr('content')

      let package = {};
      package.link = link;
      package.title = title;
      package.image = image;
      res.send(package);
  })
  .catch(function (error) {
      res.send(error);
  })
})

const getDecodedFromJwt = (token) => {
  return jwt.verify(token, secret, function(err, decoded) {
    if (err) {
      return "invalid_token";
    } else {
      return decoded;
    }
  });
}

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})