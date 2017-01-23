# Fluree

## Fluree Client for React + FlureeQL

### Usage:

```js
import {
	ReactConnect, 
	FlureeProvider, 
	flureeQL
} from 'fql-react';

const conn = ReactConnect({
    url: "http://instance-domain.flur.ee",
    instance: "instance name",
    token: "a token"
});

const userQuery = {
	vars:  ["username"],
	graph: [
		["user" {id: ["username", "?username"]}
			["username", "doc", {person: ["nameGiven", "nameFamily"]}]]
	]
};

const UserComponent = ({username, data}) => (
    <div>
        <h3>UserComponent ID: {data.id}</h3>
        <p>Error: {JSON.stringify(data.error)}</p>
        <p>Warnings: {JSON.stringify(data.warning)}</p>
        <p>username Provided: {username}</p>
        <p>username from result: {data.result.user && data.result.user.username}</p>
        <p>Given name: {data.result.user && data.result.user.person && data.result.user.person.nameGiven}</p>
    </div>
);

const UserComponentWithData = flureeQL(userQuery)(UserComponent);

const SampleProviderComponent = () => (
	<FlureeProvider conn={conn}>
    	<UserComponent username="test@user.com"/>
	</FlureeProvider>
);

export default SampleProviderComponent;

```

### Usage with graphql:
```js
import gql from fql-graphql;
import {
	ReactConnect, 
	FlureeProvider, 
	flureeQL
} from 'fql-react';

const conn = ReactConnect({
    url: "http://instance-domain.flur.ee",
    instance: "instance name",
    token: "a token"
});

const userQuery = gql`
	query UserQuery($username: String) {
        user (id: ["username", $username) {
            username 
            doc
            person {
            	nameGiven
            	nameFamily
            }
        }
    }
`;

const UserComponent = ({username, data}) => (
    <div>
        <h3>UserComponent ID: {data.id}</h3>
        <p>Error: {JSON.stringify(data.error)}</p>
        <p>Warnings: {JSON.stringify(data.warning)}</p>
        <p>username Provided: {username}</p>
        <p>username from result: {data.result.user && data.result.user.username}</p>
        <p>Given name: {data.result.user && data.result.user.person && data.result.user.person.nameGiven}</p>
    </div>
);

const UserComponentWithData = flureeQL(userQuery)(UserComponent);

const SampleProviderComponent = () => (
	<FlureeProvider conn={conn}>
    	<UserComponent username="test@user.com"/>
	</FlureeProvider>
);

export default SampleProviderComponent;

```

