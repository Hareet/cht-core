#!/bin/bash
set -e
sudo shutdown -P +60
echo Cloning cht-core to /cht-core
sudo apt-get install gh
git config --global user.name $GITHUB_ACTOR
gh auth login --with-token $GITHUB_TOKEN
git config --global 'credential.https://github.com.helper' ''
git config --global --add 'credential.https://github.com.helper' '!gh auth git-credential'

gh auth status
# git config --global --add hub.token $GIT_TOKEN
# git config --global hub.protocol https
gh repo clone medic/cht-core


#git clone --single-branch --branch $TAG_NAME https://github.com/medic/cht-core.git;

cd cht-core
# create a topic branch
# git checkout -b jmeter-feature
# make some changes...
touch test-jmeter.txt
git add test-jmeter.txt
git commit -am "done with feature"

# It's time to fork the repo!
#hub fork --remote-name origin
#git remote add origin git@github.com:medic/cht-core.git
git switch -c jmeter-feature
# push the changes to your new remote
#git push origin jmeter-feature

# check the CI status for this branch
#hub ci-status --verbose

# open a pull request for the branch you've just pushed
#hub pull-request
gh pr create

# cd cht-core/tests/scalability
# export NODE_TLS_REJECT_UNAUTHORIZED=0

# sudo apt-get update

# echo installing JAVA
# sudo apt-get install default-jre -y

# echo installing node
# curl -sL https://deb.nodesource.com/setup_10.x | sudo -E bash -
# sudo apt-get install -y nodejs

# echo "Changing config to match url arg"
# node -p "const fs = require('fs');var path = './config.json';var config = JSON.stringify({...require(path), url: '$MEDIC_URL/medic'}, null, 2);fs.writeFileSync(path,config,{encoding:'utf8',flag:'w'});"
# echo "npm install for jmeter suite"
# npm install
# echo "jmeter install"
# wget https://dlcdn.apache.org//jmeter/binaries/apache-jmeter-5.4.3.tgz -O ./apache-jmeter.tgz &&
# mkdir ./jmeter && tar -xf apache-jmeter.tgz -C ./jmeter --strip-components=1
# echo "Installing Plugins" &&
# wget  https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-manager/1.4/jmeter-plugins-manager-1.4.jar -O ./jmeter/lib/ext/jmeter-plugins-manager-1.4.jar &&
# wget 'http://search.maven.org/remotecontent?filepath=kg/apc/cmdrunner/2.2/cmdrunner-2.2.jar' -O ./jmeter/lib/cmdrunner-2.2.jar &&
# java -cp jmeter/lib/ext/jmeter-plugins-manager-1.4.jar org.jmeterplugins.repository.PluginManagerCMDInstaller &&
# ./jmeter/bin/PluginsManagerCMD.sh install jpgc-mergeresults &&
# echo "jmeter do it!"
# ./jmeter/bin/jmeter -n  -t sync.jmx -Jworking_dir=./ -Jnode_binary=$(which node) -l ./report/cli_run.jtl -e -o ./report
# mv ./jmeter.log ./report/jmeter.log
# echo "Installing AWS CLI"
# sudo apt-get install unzip -y
# curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
# unzip awscliv2.zip
# sudo ./aws/install
# # echo "Uploading logs and screenshots to ${S3_PATH}..."
# # /usr/local/bin/aws s3 cp ./report "$S3_PATH" --recursive
# git switch -c jmeter-test3-${TAG_NAME}
# mv report/cli_run.jtl previous_results/${TAG_NAME}.jtl

# git add previous_results/*
# git commit -m'Adding jmeter restults'
# zip -r report.zip report
# git add report.zip
# git commit -m'Adding zip report'
# #git restore .


# git push --set-upstream origin jmeter-test3-${TAG_NAME}
# git request-pull master origin
echo "FINISHED! "