// Load the AWS SDK for Node.js
const AWS = require('aws-sdk');
// Load credentials and set region from JSON file
AWS.config.loadFromPath('./config.json');

// Create EC2 service object
const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});

const instanceParams = {
   ImageId: 'ami-39f8215b', // ami-id for Sydney region
   InstanceType: 't2.micro', // ec2 instance type
   MinCount: 1,
   MaxCount: 1
};

// function to create ec2 instance
ec2.runInstances(instanceParams,function(err,data){
    if (err) {
        console.log('Could not create EC2 instance', err) // an error occurred
        return
    }
    const instanceId = data.Instances[0].InstanceId;
    console.log(`\n EC2 instance created successfully. Instance ID = "${instanceId}"`);

    const tagParams = {Resources: [instanceId], Tags: [
        {
           Key: 'Name',
           Value: 'EC2 instance lifecycle exercise'
        }
     ]};

// function to add tags to the ec2 instance
ec2.createTags(tagParams, function(err) {
    if (err) {
        console.log('Could not tag EC2 instance', err) // an error occurred
        return
    }
    console.log('\n EC2 instance has been tagged successfully')
    console.log('\n Running test to verify if instance has reached a stable state......');
})

    const instanceActionsParams = { InstanceIds: [instanceId] }

// function to poll the ec2 instance to be stable
ec2.waitFor('instanceRunning', instanceActionsParams, function(err, data) {
    if (err) console.log(err, err.stack) // an error occurred
    else {
        console.log(`\n EC2 instance check has been stabalised. Status of instance = "${data.Reservations[0].Instances[0].State.Name}"`)
        cleanupInstance();
    }
})

// function to initiate instance cleanup
const cleanupInstance = () => {
    console.log(`\n Cleaning up instance with ${instanceId} as it has been successfully created.`);
    ec2.terminateInstances(instanceActionsParams, function(err, data) {
    if (err) console.log(err, err.stack); // an error occurred
    else {
        console.log(`\n Instance with Instance ID "${data.TerminatingInstances[0].InstanceId}" has been deleted successfully`);
        console.log(`\n Previous status of the above EC2 instance ("${data.TerminatingInstances[0].InstanceId}") was "${data.TerminatingInstances[0].PreviousState.Name}"`);
        console.log(`\n Current status of the above EC2 instance ("${data.TerminatingInstances[0].InstanceId}") is "${data.TerminatingInstances[0].CurrentState.Name}"`);
        console.log('\n Waiting for instance to be terminated......');

        // function to poll the ec2 instance to be terminated
        ec2.waitFor('instanceTerminated', instanceActionsParams, function(err, data) {
            if (err) console.log(err, err.stack); // an error occurred
            else     console.log(`\n Instance shut down complete! Current status of the instance = "${data.Reservations[0].Instances[0].State.Name}"`);           // successful response
          });
    }
    });
}
})