
import socket, requests, json

from _thread import *
import threading

print_lock = threading.Lock()

def threaded(conn):
    while True:
        try:
            result = []
            for x in ['couchdb.1', 'couchdb.2', 'couchdb.3']:
                try:
                    r = requests.get("http://admin:password@" + x + ':5984/_membership', timeout=1)
                except requests.exceptions.Timeout as e:
                    print("One timed out")
                data = r.json()
                if data['all_nodes'] == data['cluster_nodes'] and data['all_nodes'] is not None:
                    print("Everything is fine")
                    result.append(b"up\n")
                    print(result)
                else:
                    print("_Membership shows not all nodes are part of Cluster")
                    result.append(b"down\n")
                    print(result)
        except Exception as e:
            print(e)
            conn.close()
        finally:
            if b"down\n" in result:
                conn.send(b"down\n")
            else:
                conn.send(b"up\n")
        if not ConnectionResetError: 
            print_lock.release()
            break
        print_lock.release()
    print("client disconnected")



def Main():


    serv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    serv.bind(('0.0.0.0', 5555))
    serv.listen(5)
    while True:
        conn, addr = serv.accept()

        print_lock.acquire()
        print('Connected to:', addr[0], ':', addr[1])

        start_new_thread(threaded, (conn,))

    conn.close()

if __name__ == '__main__':
    Main()
